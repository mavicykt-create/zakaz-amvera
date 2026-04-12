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

const DISPLAY_PRICE_TYPE_ID = '78de8a88-c52f-11ef-88c6-26d1a1d6853b'; // цена для карточки
const CART_PRICE_TYPE_ID = 'c66e06be-c4eb-11ef-88c6-26d1a1d6853b'; // цена для корзины и заказа

const MAX_EXCHANGE_FILE_SIZE = Number(
  process.env.MAX_EXCHANGE_FILE_SIZE || 200 * 1024 * 1024
);

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : '/data';

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
  groups: [],
  products: [],
  totalOffers: 0,
  error: null,
  source: 'commerceml'
};

let refreshInProgress = false;

app.use(cors());

app.all(
  ['/1c_exchange.php', '/commerceml/1c_exchange.php', '/bitrix/admin/1c_exchange.php'],
  requireExchangeAuth,
  express.raw({ type: '*/*', limit: MAX_EXCHANGE_FILE_SIZE }),
  async (req, res) => {
    try {
      await handleExchangeRequest(req, res);
    } catch (error) {
      console.error('1C exchange fatal error:', error);
      res
        .status(500)
        .type('text/plain; charset=utf-8')
        .send(`failure\n${error.message || 'Ошибка обмена'}`);
    }
  }
);

app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_EXCHANGE_FILE_SIZE }
});

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(SOURCE_IMAGES_DIR, { recursive: true });
  await fs.mkdir(EXCHANGE_UPLOAD_DIR, { recursive: true });

  try {
    await fs.access(ORDERS_FILE);
  } catch {
    await fs.writeFile(ORDERS_FILE, '[]', 'utf8');
  }

  try {
    await fs.access(CATALOG_FILE);
  } catch {
    await fs.writeFile(
      CATALOG_FILE,
      JSON.stringify(
        {
          loadedAt: null,
          categories: [],
          groups: [],
          products: [],
          totalOffers: 0,
          error: null,
          source: 'commerceml'
        },
        null,
        2
      ),
      'utf8'
    );
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

function parseNumber(value, fallback = 0) {
  const text = cleanText(value).replace(',', '.');
  const num = Number(text);
  return Number.isFinite(num) ? num : fallback;
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

    if (!Array.isArray(catalogState.groups)) {
      catalogState.groups = Array.isArray(catalogState.categories)
        ? catalogState.categories.filter((x) => x?.kind === 'group' || !x?.kind)
        : [];
    }
  } catch (error) {
    console.error('Failed to load catalog from disk:', error);
  }
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
  const lower = String(name || '').toLowerCase();
  return files.find((f) => f.toLowerCase().includes(lower)) || null;
}

function parseClassifierGroups(groups, parentId = null, acc = []) {
  for (const group of normalizeArray(groups)) {
    const id = firstText(group.Ид);
    const name = firstText(group.Наименование);

    if (id && name) {
      acc.push({
        id,
        name,
        parentId: parentId || null,
        kind: 'group'
      });
    }

    const nested = group.Группы?.Группа || group.Группа || [];
    if (normalizeArray(nested).length) {
      parseClassifierGroups(nested, id, acc);
    }
  }

  return acc;
}

function buildPropertyNameMap(classifier) {
  const map = new Map();

  const properties = normalizeArray(classifier?.Свойства?.Свойство);
  for (const prop of properties) {
    const id = firstText(prop.Ид);
    const name = firstText(prop.Наименование);
    if (id && name) {
      map.set(id, name);
    }
  }

  return map;
}

function getProductPropEntries(product) {
  const result = [];

  const propRows = normalizeArray(
    product.ЗначенияСвойств?.ЗначенияСвойства ||
    product.ЗначенияСвойств?.ЗначениеСвойства
  );

  for (const row of propRows) {
    result.push({
      id: firstText(row.Ид),
      value: firstText(row.Значение)
    });
  }

  return result;
}

function getProductRequisiteEntries(product) {
  const result = [];

  const reqRows = normalizeArray(product.ЗначенияРеквизитов?.ЗначениеРеквизита);
  for (const row of reqRows) {
    result.push({
      name: firstText(row.Наименование),
      value: firstText(row.Значение)
    });
  }

  return result;
}

function extractShelfLife(product, propertyNameMap) {
  const requisites = getProductRequisiteEntries(product);

  for (const req of requisites) {
    const name = cleanText(req.name).toLowerCase();
    if (name.includes('срок годности')) {
      return parseDateToRu(req.value);
    }
  }

  const props = getProductPropEntries(product);
  for (const prop of props) {
    const propName = cleanText(propertyNameMap.get(prop.id) || '').toLowerCase();
    if (propName.includes('срок годности')) {
      return parseDateToRu(prop.value);
    }
  }

  return '';
}

async function parseImportXml(xmlPath) {
  const xml = await fs.readFile(xmlPath, 'utf8');
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    trim: true,
    mergeAttrs: false
  });

  const root = parsed?.КоммерческаяИнформация;
  const catalog = root?.Каталог;

  if (!catalog) {
    throw new Error('В import.xml не найден узел КоммерческаяИнформация/Каталог');
  }

  const classifier = root?.Классификатор || catalog?.Классификатор || {};
  const groups = parseClassifierGroups(
    classifier?.Группы?.Группа || catalog?.Группы?.Группа || []
  );

  const groupMap = new Map(groups.map((g) => [g.id, g.name]));
  const propertyNameMap = buildPropertyNameMap(classifier);

  const products = normalizeArray(catalog.Товары?.Товар)
    .map((item) => {
      const id = firstText(item.Ид);
      const vendorCode =
        firstText(item.Артикул) ||
        firstText(item.Код) ||
        firstText(item.АртикулТовара);

      const name = firstText(item.Наименование);

      const groupIds = normalizeArray(item.Группы?.Ид || item.Группы?.Группа?.Ид)
        .map(firstText)
        .filter(Boolean);

      const groupId = groupIds[0] || '';
      const groupName = groupMap.get(groupId) || '';

      const imageRaw = firstText(item.Картинка);
      const barcode = firstText(item.Штрихкод);
      const weight = parseNumber(firstText(item.Вес), 0);
      const shelfLife = extractShelfLife(item, propertyNameMap);

      return {
        id,
        vendorCode,
        barcode,
        name,
        categoryId: groupId,
        categoryName: groupName,
        groupId,
        groupName,
        groupIds,
        imageRaw,
        image: '',
        shelfLife,
        weight,
        stock: 0,
        cartPrice: 0,
        cartPriceText: '',
        displayPrice: 0,
        displayPriceText: '',
        prices: []
      };
    })
    .filter((p) => p.id && p.name);

  const sortedGroups = groups
    .filter((g) => g.id && g.name)
    .sort((a, b) =>
      a.name.localeCompare(b.name, 'ru', { sensitivity: 'base', numeric: true })
    )
    .map((g) => ({
      id: g.id,
      name: g.name,
      parentId: g.parentId || null,
      kind: 'group'
    }));

  return {
    categories: sortedGroups,
    groups: sortedGroups,
    products
  };
}

function extractPricesFromOffer(offer) {
  const prices = [];
  const rows = normalizeArray(offer.Цены?.Цена);

  for (const row of rows) {
    prices.push({
      typeId: firstText(row.ИдТипаЦены),
      typeName: firstText(row.Наименование),
      presentation: firstText(row.Представление),
      value: parseNumber(firstText(row.ЦенаЗаЕдиницу), 0),
      currency: firstText(row.Валюта),
      unit: firstText(row.Единица),
      coefficient: parseNumber(firstText(row.Коэффициент), 1)
    });
  }

  return prices;
}

async function parseOffersXml(xmlPath) {
  const xml = await fs.readFile(xmlPath, 'utf8');
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    trim: true,
    mergeAttrs: false
  });

  const root = parsed?.КоммерческаяИнформация;
  const packageNode = root?.ПакетПредложений || root?.Каталог;

  if (!packageNode) {
    throw new Error('В offers.xml не найден узел ПакетПредложений');
  }

  const priceTypes = normalizeArray(packageNode.ТипыЦен?.ТипЦены)
    .map((p) => ({
      id: firstText(p.Ид),
      name: firstText(p.Наименование)
    }))
    .filter((p) => p.id);

  const priceTypeNameMap = new Map(priceTypes.map((p) => [p.id, p.name]));

  const offers = normalizeArray(packageNode.Предложения?.Предложение)
    .map((offer) => {
      const id = firstText(offer.Ид);
      const quantity = parseNumber(firstText(offer.Количество), 0);
      const vendorCode = firstText(offer.Артикул);
      const barcode = firstText(offer.Штрихкод);

      const prices = extractPricesFromOffer(offer).map((p) => ({
        ...p,
        resolvedName: cleanText(p.typeName || priceTypeNameMap.get(p.typeId) || p.presentation)
      }));

      return { id, quantity, vendorCode, barcode, prices };
    })
    .filter((o) => o.id);

  return { offers };
}

function pickCartAndDisplayPrice(prices) {
  if (!Array.isArray(prices) || !prices.length) {
    return {
      cartPrice: 0,
      cartPriceText: '',
      displayPrice: 0,
      displayPriceText: ''
    };
  }

  const displayRow = prices.find((p) => p.typeId === DISPLAY_PRICE_TYPE_ID) || null;
  const cartRow = prices.find((p) => p.typeId === CART_PRICE_TYPE_ID) || null;

  return {
    cartPrice: cartRow?.value || 0,
    cartPriceText: cartRow?.presentation || '',
    displayPrice: displayRow?.value || 0,
    displayPriceText: displayRow?.presentation || ''
  };
}

function safeRelativePath(baseDir, fullPath) {
  const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
  if (rel.startsWith('../')) {
    throw new Error('Некорректный относительный путь');
  }
  return rel;
}

async function copyImagesToStorage(extractedDir) {
  const files = await collectFilesRecursive(extractedDir);
  const imageFiles = files.filter((f) => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));

  const sourceByRelative = new Map();
  const sourceByBase = new Map();

  for (const file of imageFiles) {
    const rel = safeRelativePath(extractedDir, file);
    const normalizedRel = rel.replace(/^\/+/, '');
    const target = path.join(SOURCE_IMAGES_DIR, normalizedRel);

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file, target);

    const publicUrl = `/uploads/images/${normalizedRel
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;

    sourceByRelative.set(normalizedRel, publicUrl);
    sourceByBase.set(path.basename(file), publicUrl);
  }

  return { sourceByRelative, sourceByBase };
}

async function buildCatalogFromCommerceML(extractedDir) {
  const files = await collectFilesRecursive(extractedDir);
  const importXml = findFirstByName(files, 'import.xml');
  const offersXml = findFirstByName(files, 'offers.xml');

  if (!importXml) throw new Error('В каталоге обмена не найден import.xml');
  if (!offersXml) throw new Error('В каталоге обмена не найден offers.xml');

  const [importData, offersData, imageMaps] = await Promise.all([
    parseImportXml(importXml),
    parseOffersXml(offersXml),
    copyImagesToStorage(extractedDir)
  ]);

  const productMap = new Map(importData.products.map((p) => [p.id, p]));
  let matchedOffers = 0;

  for (const offer of offersData.offers) {
    const rawOfferId = offer.id || '';
    const productId = rawOfferId.includes('#') ? rawOfferId.split('#')[0] : rawOfferId;

    const product = productMap.get(productId);
    if (!product) continue;

    const selected = pickCartAndDisplayPrice(offer.prices);

    product.cartPrice = selected.cartPrice;
    product.cartPriceText = selected.cartPriceText;
    product.displayPrice = selected.displayPrice;
    product.displayPriceText = selected.displayPriceText;
    product.stock = offer.quantity;
    product.prices = offer.prices;

    if (!product.vendorCode) product.vendorCode = offer.vendorCode;
    if (!product.barcode) product.barcode = offer.barcode;

    matchedOffers += 1;
  }

  for (const product of productMap.values()) {
    let image = '';

    if (product.imageRaw) {
      const normalizedRaw = product.imageRaw.replace(/\\/g, '/').replace(/^\/+/, '');
      image =
        imageMaps.sourceByRelative.get(normalizedRaw) ||
        imageMaps.sourceByBase.get(path.basename(normalizedRaw)) ||
        '';
    }

    if (!image && product.vendorCode) {
      const tryNames = [
        `${product.vendorCode}.jpg`,
        `${product.vendorCode}.jpeg`,
        `${product.vendorCode}.png`,
        `${product.vendorCode}.webp`
      ];
      const found = tryNames.find((name) => imageMaps.sourceByBase.has(name));
      image = found ? imageMaps.sourceByBase.get(found) : '';
    }

    product.image = image || '';
  }

  const groups = importData.groups || [];
  const categories = importData.categories || groups;
  const products = sortRuByName([...productMap.values()]);

  console.log('[CommerceML] import.xml:', path.basename(importXml));
  console.log('[CommerceML] offers.xml:', path.basename(offersXml));
  console.log('[CommerceML] groups:', groups.length);
  console.log('[CommerceML] products:', products.length);
  console.log('[CommerceML] offers matched:', matchedOffers);

  return {
    loadedAt: new Date().toISOString(),
    categories,
    groups,
    products,
    totalOffers: offersData.offers.length,
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
    return res.status(401).type('text/plain; charset=utf-8').send('failure\nUnauthorized');
  }

  next();
}

function sanitizeExchangeFilename(filename) {
  const normalized = String(filename || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();

  const parts = normalized
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== '.' && part !== '..');

  return parts.join('/');
}

async function ensureExchangeDir() {
  await fs.mkdir(EXCHANGE_UPLOAD_DIR, { recursive: true });
}

async function writeExchangeFile(filename, body) {
  const target = path.join(EXCHANGE_UPLOAD_DIR, filename);
  const targetDir = path.dirname(target);

  await fs.mkdir(targetDir, { recursive: true });

  let exists = false;
  try {
    await fs.access(target);
    exists = true;
  } catch {}

  if (exists) {
    await fs.appendFile(target, body);
  } else {
    await fs.writeFile(target, body);
  }

  return target;
}

async function tryImportFromExchangeDir() {
  const files = await collectFilesRecursive(EXCHANGE_UPLOAD_DIR).catch(() => []);
  const importXml = findFirstByName(files, 'import.xml');
  const offersXml = findFirstByName(files, 'offers.xml');

  if (!importXml || !offersXml) {
    return {
      ok: false,
      waitingFor: !importXml ? 'import.xml' : 'offers.xml',
      files: files.map((f) => safeRelativePath(EXCHANGE_UPLOAD_DIR, f))
    };
  }

  const catalog = await buildCatalogFromCommerceML(EXCHANGE_UPLOAD_DIR);
  await saveCatalog(catalog);

  return {
    ok: true,
    loadedAt: catalog.loadedAt,
    products: catalog.products.length,
    categories: catalog.categories.length,
    groups: Array.isArray(catalog.groups) ? catalog.groups.length : 0,
    totalOffers: catalog.totalOffers
  };
}

async function handleExchangeRequest(req, res) {
  const mode = String(req.query.mode || '').toLowerCase();
  const type = String(req.query.type || '').toLowerCase();
  const importFilename = String(req.query.filename || '').toLowerCase();

  console.log(
    `[1C] mode=${mode || '-'} type=${type || '-'} filename=${String(req.query.filename || '')} length=${req.headers['content-length'] || '0'}`
  );

  if (type && type !== 'catalog') {
    return res
      .type('text/plain; charset=utf-8')
      .send('failure\nПоддерживается только type=catalog');
  }

  if (mode === 'checkauth') {
    return res
      .type('text/plain; charset=utf-8')
      .send(`success\n${EXCHANGE_SESSION_NAME}\n${EXCHANGE_SESSION_ID}`);
  }

  if (mode === 'init') {
    return res
      .type('text/plain; charset=utf-8')
      .send(`zip=no\nfile_limit=${MAX_EXCHANGE_FILE_SIZE}`);
  }

  if (mode === 'file') {
    await ensureExchangeDir();

    const filename = sanitizeExchangeFilename(req.query.filename || req.query.file || '');
    if (!filename) {
      return res
        .status(400)
        .type('text/plain; charset=utf-8')
        .send('failure\nНе передано имя файла');
    }

    const body = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body || '');

    console.log('[1C] save start:', filename);

    const target = await writeExchangeFile(filename, body);

    console.log('[1C] saved file:', {
      filename,
      bytes: body.length,
      target
    });

    return res.type('text/plain; charset=utf-8').send('success');
  }

  if (mode === 'import') {
    try {
      if (importFilename.includes('import')) {
        console.log('[1C] import step for import.xml');
        return res.type('text/plain; charset=utf-8').send('success');
      }

      if (importFilename.includes('offers')) {
        const result = await tryImportFromExchangeDir();
        console.log('[1C] import result:', result);

        if (!result.ok) {
          return res
            .status(500)
            .type('text/plain; charset=utf-8')
            .send(`failure\nНе найден файл ${result.waitingFor}`);
        }

        return res.type('text/plain; charset=utf-8').send('success');
      }

      return res.type('text/plain; charset=utf-8').send('success');
    } catch (error) {
      console.error('[1C] import error:', error);
      return res
        .status(500)
        .type('text/plain; charset=utf-8')
        .send(`failure\n${error.message || 'Ошибка импорта'}`);
    }
  }

  return res
    .status(400)
    .type('text/plain; charset=utf-8')
    .send('failure\nНеизвестный mode');
}

app.get('/api/health', (req, res) => {
  const loadedAtTs = catalogState.loadedAt ? new Date(catalogState.loadedAt).getTime() : 0;
  const isFresh = loadedAtTs ? Date.now() - loadedAtTs < CACHE_TTL_MS : false;

  res.json({
    ok: true,
    loadedAt: catalogState.loadedAt,
    products: catalogState.products.length,
    categories: catalogState.categories.length,
    groups: Array.isArray(catalogState.groups) ? catalogState.groups.length : 0,
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
      groups: Array.isArray(catalog.groups) ? catalog.groups.length : 0,
      products: catalog.products.length,
      totalOffers: catalog.totalOffers
    });
  } catch (error) {
    console.error('CommerceML ZIP import error:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Ошибка обработки CommerceML'
    });
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
        cartPriceText: cleanText(item.cartPriceText),
        displayPrice: Number(item.displayPrice) || 0,
        displayPriceText: cleanText(item.displayPriceText),
        sum: quantity * cartPrice
      };
    })
    .filter((item) => item.quantity > 0);

  if (!normalizedItems.length) {
    return res.status(400).json({
      ok: false,
      error: 'Нет товаров с количеством больше нуля'
    });
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
  if (!imageUrl) {
    return res.status(400).send('No url');
  }

  let resolvedPath = imageUrl;
  if (imageUrl.startsWith('/uploads/')) {
    resolvedPath = path.join(DATA_DIR, imageUrl.replace(/^\/uploads\//, 'uploads/'));
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
      const response = await fetch(imageUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 Mobile Order Bot' }
      });

      if (!response.ok) {
        throw new Error('Image fetch failed');
      }

      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    }

    const optimized = await sharp(buffer)
      .resize({
        width: IMAGE_WIDTH,
        height: IMAGE_WIDTH,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: IMAGE_QUALITY })
      .toBuffer();

    const file = path.join(IMAGE_CACHE_DIR, `${key}.webp`);
    await fs.writeFile(file, optimized);

    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(optimized);
  } catch (error) {
    console.error('Image proxy error:', error);

    if (imageUrl.startsWith('/uploads/')) {
      return res.sendFile(resolvedPath);
    }

    return res.redirect(imageUrl);
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
