import express from 'express';
import cors from 'cors';
import sharp from 'sharp';
import multer from 'multer';
import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { parseStringPromise } from 'xml2js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '12345');
const IMAGE_WIDTH = Number(process.env.IMAGE_WIDTH || 220);
const IMAGE_QUALITY = Number(process.env.IMAGE_QUALITY || 42);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const EXCHANGE_LOGIN = String(process.env.EXCHANGE_LOGIN || 'admin');
const EXCHANGE_PASSWORD = String(process.env.EXCHANGE_PASSWORD || ADMIN_PASSWORD);
const EXCHANGE_SESSION_NAME = 'sessid';
const EXCHANGE_SESSION_ID = 'zakazamvera';
const MAX_EXCHANGE_FILE_SIZE = Number(process.env.MAX_EXCHANGE_FILE_SIZE || 1024 * 1024 * 500);

const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'cache');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(UPLOADS_DIR, 'tmp');
const SOURCE_IMAGES_DIR = path.join(UPLOADS_DIR, 'images');
const EXCHANGE_UPLOAD_DIR = path.join(TMP_DIR, 'exchange');

let catalogState = {
  loadedAt: null,
  categories: [],
  products: [],
  totalOffers: 0,
  error: null,
  source: 'commerceml'
};

let refreshInProgress = false;

app.use(cors());
app.all(['/1c_exchange.php', '/commerceml/1c_exchange.php', '/bitrix/admin/1c_exchange.php'], requireExchangeAuth, express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
  try {
    await handleExchangeRequest(req, res);
  } catch (error) {
    res.status(500).type('text/plain; charset=utf-8').send(`failure\n${error.message || 'Ошибка обмена'}`);
  }
});
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 1024 * 1024 * 500 }
});

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(SOURCE_IMAGES_DIR, { recursive: true });
  await fs.mkdir(EXCHANGE_UPLOAD_DIR, { recursive: true });

  try { await fs.access(ORDERS_FILE); } catch { await fs.writeFile(ORDERS_FILE, '[]', 'utf8'); }
  try { await fs.access(CATALOG_FILE); } catch {
    await fs.writeFile(CATALOG_FILE, JSON.stringify({
      loadedAt: null,
      categories: [],
      products: [],
      totalOffers: 0,
      error: null,
      source: 'commerceml'
    }, null, 2), 'utf8');
  }
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function firstText(value) {
  if (Array.isArray(value)) return cleanText(value[0]);
  if (typeof value === 'object' && value && '_' in value) return cleanText(value._);
  return cleanText(value);
}

function parseDateToRu(raw) {
  const text = cleanText(raw);
  if (!text) return '';

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1].slice(2)}`;

  const fullIso = text.match(/^(\d{4})-(\d{2})-(\d{2})[T\s]/);
  if (fullIso) return `${fullIso[3]}.${fullIso[2]}.${fullIso[1].slice(2)}`;

  const ru = text.match(/^(\d{2})\.(\d{2})\.(\d{2,4})$/);
  if (ru) {
    const yy = ru[3].length === 4 ? ru[3].slice(2) : ru[3];
    return `${ru[1]}.${ru[2]}.${yy}`;
  }

  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(2);
    return `${dd}.${mm}.${yy}`;
  }

  return text;
}

function sortRuByName(items) {
  return [...items].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'ru', {
      sensitivity: 'base',
      numeric: true
    })
  );
}

function requireAdmin(req, res, next) {
  const password = String(req.query.password || req.headers['x-admin-password'] || '');
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Неверный пароль' });
  }
  next();
}

async function readOrders() {
  const text = await fs.readFile(ORDERS_FILE, 'utf8');
  return JSON.parse(text);
}

async function writeOrders(orders) {
  await fs.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

async function loadCatalogFromDisk() {
  try {
    const text = await fs.readFile(CATALOG_FILE, 'utf8');
    catalogState = JSON.parse(text);
  } catch {}
}

function simpleHash(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

async function readImageCache(key) {
  const file = path.join(IMAGE_CACHE_DIR, `${key}.webp`);
  try {
    const stat = await fs.stat(file);
    const fresh = Date.now() - stat.mtimeMs < CACHE_TTL_MS;
    if (!fresh) return null;
    return file;
  } catch {
    return null;
  }
}

async function extractZip(zipPath, targetDir) {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(targetDir, true);
}

async function collectFilesRecursive(dir) {
  const out = [];
  async function walk(current) {
    const items = await fs.readdir(current, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

function findFirstByName(files, name) {
  return files.find((f) =>
    f.toLowerCase().includes(name.toLowerCase())
  ) || null;
}

function parseClassifierGroups(groups, parentId = null, acc = []) {
  for (const group of normalizeArray(groups)) {
    const id = firstText(group.Ид);
    const name = firstText(group.Наименование);
    if (id && name) acc.push({ id, name, parentId });
    const children = group.Группы?.Группа;
    if (children) parseClassifierGroups(children, id || parentId, acc);
  }
  return acc;
}

function getProductPropMap(product) {
  const result = {};
  const values = normalizeArray(product.ЗначенияСвойств?.ЗначенияСвойства);
  for (const v of values) {
    const propId = firstText(v.Ид);
    const propValue = firstText(v.Значение);
    if (propId) result[propId] = propValue;
  }
  return result;
}

async function parseImportXml(xmlPath) {
  const xml = await fs.readFile(xmlPath, 'utf8');
  const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true });

  const catalog = parsed?.КоммерческаяИнформация?.Каталог;
  if (!catalog) throw new Error('В import.xml не найден узел КоммерческаяИнформация/Каталог');

  const classifier = catalog.Классификатор || {};
  const groupList = parseClassifierGroups(classifier.Группы?.Группа || []);
  const categoryMap = new Map(groupList.map((g) => [g.id, g.name]));

  const propertyDefs = normalizeArray(classifier.Свойства?.Свойство).map((p) => ({
    id: firstText(p.Ид),
    name: firstText(p.Наименование)
  })).filter((p) => p.id && p.name);
  const propertyNameMap = new Map(propertyDefs.map((p) => [p.id, p.name]));

  const products = normalizeArray(catalog.Товары?.Товар).map((item) => {
    const id = firstText(item.Ид);
    const article = firstText(item.Артикул) || firstText(item.Код) || firstText(item.АртикулТовара);
    const name = firstText(item.Наименование);
    const groupId = firstText(item.Группы?.Ид || item.Группы?.Группа?.Ид);
    const imageRaw = firstText(item.Картинка);
    const propValues = getProductPropMap(item);

    let shelfLife = '';
    for (const [propId, value] of Object.entries(propValues)) {
      const propName = propertyNameMap.get(propId);
      if (propName && cleanText(propName).toLowerCase() === 'срок годности') {
        shelfLife = parseDateToRu(value);
      }
    }

    return {
      id,
      vendorCode: article,
      name,
      categoryId: groupId,
      categoryName: categoryMap.get(groupId) || '',
      imageRaw,
      shelfLife,
      stock: 0,
      cartPrice: 0,
      displayPrice: 0
    };
  }).filter((p) => p.id && p.name);

  return { categories: groupList.map((g) => ({ id: g.id, name: g.name })), products };
}

function extractPricesFromOffer(offer) {
  const prices = [];
  const rows = normalizeArray(offer.Цены?.Цена);
  for (const row of rows) {
    prices.push({
      typeId: firstText(row.ИдТипаЦены),
      typeName: firstText(row.Представление || row.Наименование),
      value: Number(firstText(row.ЦенаЗаЕдиницу)) || 0
    });
  }
  return prices;
}

async function parseOffersXml(xmlPath) {
  const xml = await fs.readFile(xmlPath, 'utf8');
  const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true });

  const packageNode = parsed?.КоммерческаяИнформация?.ПакетПредложений || parsed?.КоммерческаяИнформация?.Каталог;
  if (!packageNode) throw new Error('В offers.xml не найден узел ПакетПредложений');

  const priceTypes = normalizeArray(packageNode.ТипыЦен?.ТипЦены).map((p) => ({
    id: firstText(p.Ид),
    name: firstText(p.Наименование)
  })).filter((p) => p.id);

  const priceTypeNameMap = new Map(priceTypes.map((p) => [p.id, p.name]));

  const offers = normalizeArray(packageNode.Предложения?.Предложение).map((offer) => {
    const id = firstText(offer.Ид);
    const quantity = Number(firstText(offer.Количество)) || 0;
    const prices = extractPricesFromOffer(offer).map((p) => ({
      ...p,
      resolvedName: p.typeName || priceTypeNameMap.get(p.typeId) || ''
    }));
    return { id, quantity, prices };
  }).filter((o) => o.id);

  return { offers };
}

function pickCartAndDisplayPrice(prices) {
  let cartPrice = 0;
  let displayPrice = 0;

  for (const p of prices) {
    const n = cleanText(p.resolvedName || p.typeName).toLowerCase();

    if (!cartPrice && (n.includes('заказ') || n.includes('основн') || n.includes('оптов') || n.includes('продаж'))) {
      cartPrice = p.value;
    }

    if (!displayPrice && (n.includes('витрин') || n.includes('сайт') || n.includes('справоч') || n.includes('рекоменд'))) {
      displayPrice = p.value;
    }
  }

  if (!cartPrice && prices[0]) cartPrice = prices[0].value;
  if (!displayPrice && prices[1]) displayPrice = prices[1].value;
  if (!displayPrice) displayPrice = cartPrice;

  return { cartPrice, displayPrice };
}

async function copyImagesToStorage(extractedDir) {
  const files = await collectFilesRecursive(extractedDir);
  const imageFiles = files.filter((f) => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));
  const sourceByBase = new Map();

  for (const file of imageFiles) {
    const base = path.basename(file);
    const target = path.join(SOURCE_IMAGES_DIR, base);
    await fs.copyFile(file, target);
    sourceByBase.set(base, `/uploads/images/${base}`);
  }

  return sourceByBase;
}

async function buildCatalogFromCommerceML(extractedDir) {
  const files = await collectFilesRecursive(extractedDir);
  const importXml = findFirstByName(files, 'import.xml');
  const offersXml = findFirstByName(files, 'offers.xml');

  if (!importXml) throw new Error('В архиве не найден import.xml');
  if (!offersXml) throw new Error('В архиве не найден offers.xml');

  const [importData, offersData, imageMap] = await Promise.all([
    parseImportXml(importXml),
    parseOffersXml(offersXml),
    copyImagesToStorage(extractedDir)
  ]);

  const productMap = new Map(importData.products.map((p) => [p.id, p]));

  for (const offer of offersData.offers) {
    const product = productMap.get(offer.id);
    if (!product) continue;
    const selected = pickCartAndDisplayPrice(offer.prices);
    product.cartPrice = selected.cartPrice;
    product.displayPrice = selected.displayPrice;
    product.stock = offer.quantity;
  }

  for (const product of productMap.values()) {
    if (product.imageRaw) {
      const base = path.basename(product.imageRaw);
      product.image = imageMap.get(base) || '';
    } else if (product.vendorCode) {
      const tryNames = [`${product.vendorCode}.jpg`, `${product.vendorCode}.jpeg`, `${product.vendorCode}.png`, `${product.vendorCode}.webp`];
      const found = tryNames.find((name) => imageMap.has(name));
      product.image = found ? imageMap.get(found) : '';
    } else {
      product.image = '';
    }
  }

  const categories = importData.categories
    .filter((c) => c.id && c.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base', numeric: true }));

  const products = sortRuByName([...productMap.values()]);

  return {
    loadedAt: new Date().toISOString(),
    categories,
    products,
    totalOffers: products.length,
    error: null,
    source: 'commerceml'
  };
}

async function saveCatalog(catalog) {
  catalogState = catalog;
  await fs.writeFile(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
}


function decodeBasicAuth(header = '') {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return {
      login: decoded.slice(0, idx),
      password: decoded.slice(idx + 1)
    };
  } catch {
    return null;
  }
}

function requireExchangeAuth(req, res, next) {
  const creds = decodeBasicAuth(String(req.headers.authorization || ''));
  if (!creds || creds.login !== EXCHANGE_LOGIN || creds.password !== EXCHANGE_PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="1C Exchange"');
    return res.status(401).send('failure\nUnauthorized');
  }
  next();
}

function sanitizeExchangeFilename(filename) {
  const normalized = String(filename || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.\.(\/|\\)/g, '')
    .trim();
  return normalized;
}

async function ensureExchangeDir() {
  await fs.mkdir(EXCHANGE_UPLOAD_DIR, { recursive: true });
}

async function resetExchangeDir() {
  await fs.rm(EXCHANGE_UPLOAD_DIR, { recursive: true, force: true });
  await fs.mkdir(EXCHANGE_UPLOAD_DIR, { recursive: true });
}

async function tryImportFromExchangeDir() {
  const files = await collectFilesRecursive(EXCHANGE_UPLOAD_DIR).catch(() => []);
  const importXml = findFirstByName(files, 'import.xml');
  const offersXml = findFirstByName(files, 'offers.xml');
  if (!importXml || !offersXml) {
    return { ok: false, waitingFor: !importXml ? 'import.xml' : 'offers.xml' };
  }

  const catalog = await buildCatalogFromCommerceML(EXCHANGE_UPLOAD_DIR);
  await saveCatalog(catalog);
  return {
    ok: true,
    loadedAt: catalog.loadedAt,
    products: catalog.products.length,
    categories: catalog.categories.length
  };
}

async function handleExchangeRequest(req, res) {
  const mode = String(req.query.mode || '').toLowerCase();
  const type = String(req.query.type || '').toLowerCase();

  if (type && type !== 'catalog') {
    return res.type('text/plain; charset=utf-8').send('failure\nПоддерживается только type=catalog');
  }

  if (mode === 'checkauth') {
    return res.type('text/plain; charset=utf-8').send(`success\n${EXCHANGE_SESSION_NAME}\n${EXCHANGE_SESSION_ID}`);
  }

  if (mode === 'init') {
    return res.type('text/plain; charset=utf-8').send(`zip=no\nfile_limit=${MAX_EXCHANGE_FILE_SIZE}`);
  }

  if (mode === 'file') {
    await ensureExchangeDir();
    const filename = sanitizeExchangeFilename(req.query.filename || req.query.file || '');
    if (!filename) {
      return res.status(400).type('text/plain; charset=utf-8').send('failure\nНе передано имя файла');
    }

    const target = path.join(EXCHANGE_UPLOAD_DIR, filename);
    const targetDir = path.dirname(target);
    await fs.mkdir(targetDir, { recursive: true });

   const body = Buffer.isBuffer(req.body)
  ? req.body
  : Buffer.from(req.body || '');

    await fs.writeFile(target, body);
    return res.type('text/plain; charset=utf-8').send('success');
  }

  if (mode === 'import') {
  console.log('IMPORT START');

  const result = await tryImportFromExchangeDir();

  console.log('IMPORT RESULT:', result);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  return res.send('success\n');
}

  return res.status(400).type('text/plain; charset=utf-8').send('failure\nНеизвестный mode');
}

app.get('/api/health', (req, res) => {
  const loadedAtTs = catalogState.loadedAt ? new Date(catalogState.loadedAt).getTime() : 0;
  const isFresh = loadedAtTs ? Date.now() - loadedAtTs < CACHE_TTL_MS : false;

  res.json({
    ok: true,
    loadedAt: catalogState.loadedAt,
    products: catalogState.products.length,
    categories: catalogState.categories.length,
    error: catalogState.error,
    source: catalogState.source,
    isFresh
  });
});

app.get('/api/products', async (req, res) => {
  if (!catalogState.products.length && !catalogState.error) {
    await loadCatalogFromDisk();
  }
  res.json({ ok: true, ...catalogState });
});

app.post('/api/commerceml/upload-zip', requireAdmin, upload.single('archive'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'Не прикреплен архив' });
  }

  if (refreshInProgress) {
    return res.status(409).json({ ok: false, error: 'Обновление уже выполняется' });
  }

  refreshInProgress = true;
  const extractDir = path.join(TMP_DIR, `extract-${Date.now()}`);

  try {
    await fs.mkdir(extractDir, { recursive: true });
    await extractZip(req.file.path, extractDir);

    const catalog = await buildCatalogFromCommerceML(extractDir);
    await saveCatalog(catalog);

    res.json({
      ok: true,
      message: 'CommerceML успешно загружен',
      loadedAt: catalog.loadedAt,
      categories: catalog.categories.length,
      products: catalog.products.length
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Ошибка обработки CommerceML' });
  } finally {
    refreshInProgress = false;
    try { await fs.rm(req.file.path, { force: true }); } catch {}
    try { await fs.rm(extractDir, { recursive: true, force: true }); } catch {}
  }
});

app.post('/api/orders', async (req, res) => {
  const { items = [], customer = '', comment = '', phone = '' } = req.body || {};

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, error: 'Пустой заказ' });
  }

  const normalizedItems = items
    .filter((item) => Number(item.quantity) > 0)
    .map((item) => {
      const quantity = Number(item.quantity) || 0;
      const cartPrice = Number(item.cartPrice) || 0;
      return {
        id: String(item.id || ''),
        vendorCode: cleanText(item.vendorCode),
        name: cleanText(item.name),
        quantity,
        cartPrice,
        displayPrice: Number(item.displayPrice) || 0,
        sum: quantity * cartPrice
      };
    })
    .filter((item) => item.quantity > 0);

  if (!normalizedItems.length) {
    return res.status(400).json({ ok: false, error: 'Нет товаров с количеством больше нуля' });
  }

  const orders = await readOrders();
  const order = {
    id: `ORD-${Date.now()}`,
    createdAt: new Date().toISOString(),
    customer: cleanText(customer),
    comment: cleanText(comment),
    phone: cleanText(phone),
    items: normalizedItems,
    totalQuantity: normalizedItems.reduce((sum, i) => sum + i.quantity, 0),
    totalSum: normalizedItems.reduce((sum, i) => sum + i.sum, 0)
  };

  orders.unshift(order);
  await writeOrders(orders);

  res.json({ ok: true, orderId: order.id, totalSum: order.totalSum });
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  const orders = await readOrders();
  res.json({ ok: true, orders });
});

app.get('/img', async (req, res) => {
  const imageUrl = String(req.query.url || '');
  if (!imageUrl) return res.status(400).send('No url');

  let resolvedPath = imageUrl;
  if (imageUrl.startsWith('/uploads/')) {
    resolvedPath = path.join(__dirname, 'data', imageUrl.replace(/^\/uploads\//, 'uploads/'));
  }

  const key = simpleHash(`${imageUrl}:${IMAGE_WIDTH}:${IMAGE_QUALITY}`);
  const cached = await readImageCache(key);

  if (cached) {
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(cached);
  }

  try {
    let buffer;
    if (imageUrl.startsWith('/uploads/')) {
      buffer = await fs.readFile(resolvedPath);
    } else {
      const response = await fetch(imageUrl, { headers: { 'user-agent': 'Mozilla/5.0 Mobile Order Bot' } });
      if (!response.ok) throw new Error('Image fetch failed');
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    }

    const optimized = await sharp(buffer)
      .resize({ width: IMAGE_WIDTH, height: IMAGE_WIDTH, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: IMAGE_QUALITY })
      .toBuffer();

    const file = path.join(IMAGE_CACHE_DIR, `${key}.webp`);
    await fs.writeFile(file, optimized);

    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(optimized);
  } catch {
    if (imageUrl.startsWith('/uploads/')) return res.sendFile(resolvedPath);
    res.redirect(imageUrl);
  }
});

app.get('/upload-commerceml', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upload-commerceml.html'));
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

await ensureStorage();
await loadCatalogFromDisk();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on :${PORT}`);
});
