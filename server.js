import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStringPromise } from 'xml2js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const YML_URL = process.env.YML_URL || 'https://milku.ru/site1/export-yandex-YML/';
const CATEGORY_ID = String(process.env.CATEGORY_ID || '54');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '12345');
const IMAGE_WIDTH = Number(process.env.IMAGE_WIDTH || 320);
const IMAGE_QUALITY = Number(process.env.IMAGE_QUALITY || 70);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);

const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const CATALOG_CACHE_FILE = path.join(DATA_DIR, 'catalog-cache.json');
const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'cache');

let catalogState = {
  loadedAt: null,
  categoryId: CATEGORY_ID,
  categoryName: '',
  products: [],
  totalOffers: 0,
  error: null
};

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true });
  try { await fs.access(ORDERS_FILE); } catch { await fs.writeFile(ORDERS_FILE, '[]', 'utf8'); }
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function getParamValue(params, name) {
  const list = normalizeArray(params);
  const found = list.find((p) => cleanText(p?.$?.name) === name);
  if (!found) return '';
  if (typeof found === 'string') return cleanText(found);
  if (typeof found?._ === 'string') return cleanText(found._);
  return cleanText(found);
}

function extractShelfLife(params) {
  const raw = getParamValue(params, 'Срок годности');
  if (!raw) return { raw: '', days: null };
  const normalized = raw.replace(',', '.');
  const num = normalized.match(/(\d+(?:\.\d+)?)/);
  const days = num ? Number(num[1]) : null;
  return { raw, days: Number.isFinite(days) ? days : null };
}

function shelfLifeBadge(days, raw) {
  if (!raw) return { text: '—', tone: 'none' };
  if (days == null) return { text: raw, tone: 'none' };
  if (days < 30) return { text: `${days} дн`, tone: 'danger' };
  if (days <= 90) return { text: `${days} дн`, tone: 'warn' };
  return { text: `${days} дн`, tone: 'ok' };
}

function firstText(value) {
  if (Array.isArray(value)) return cleanText(value[0]);
  return cleanText(value);
}

function mapOffer(offer) {
  const price = Number(firstText(offer.price)) || 0;
  const oldPrice = Number(firstText(offer.oldprice)) || null;
  const categoryId = firstText(offer.categoryId);
  const picture = firstText(offer.picture);
  const vendorCode = firstText(offer.vendorCode);
  const name = firstText(offer.name) || firstText(offer.model) || `Товар ${firstText(offer.$?.id)}`;
  const article = vendorCode || firstText(offer.$?.id) || '';
  const shelf = extractShelfLife(offer.param);
  const badge = shelfLifeBadge(shelf.days, shelf.raw);

  return {
    id: firstText(offer.$?.id) || article || crypto.randomUUID(),
    article,
    name,
    price,
    oldPrice,
    categoryId,
    image: picture,
    available: String(offer.$?.available || 'true') !== 'false',
    shelfLifeRaw: shelf.raw,
    shelfLifeDays: shelf.days,
    shelfLifeBadge: badge
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 Mobile Order Bot'
    }
  });
  if (!response.ok) {
    throw new Error(`Не удалось загрузить YML: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function refreshCatalog() {
  try {
    const xml = await fetchText(YML_URL);
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: false,
      trim: true
    });

    const shop = parsed?.yml_catalog?.shop;
    if (!shop) throw new Error('В YML не найден блок yml_catalog.shop');

    const categories = normalizeArray(shop.categories?.category).map((c) => ({
      id: String(c?.$?.id || ''),
      name: typeof c === 'string' ? cleanText(c) : cleanText(c?._)
    }));

    const category = categories.find((c) => c.id === CATEGORY_ID);
    const offersRaw = normalizeArray(shop.offers?.offer);
    const products = offersRaw
      .map(mapOffer)
      .filter((item) => String(item.categoryId) === CATEGORY_ID);

    catalogState = {
      loadedAt: new Date().toISOString(),
      categoryId: CATEGORY_ID,
      categoryName: category?.name || `Категория ${CATEGORY_ID}`,
      products,
      totalOffers: offersRaw.length,
      error: null
    };

    await fs.writeFile(CATALOG_CACHE_FILE, JSON.stringify(catalogState, null, 2), 'utf8');
    return catalogState;
  } catch (error) {
    catalogState = {
      ...catalogState,
      error: error.message || 'Неизвестная ошибка загрузки каталога'
    };
    try {
      const cached = JSON.parse(await fs.readFile(CATALOG_CACHE_FILE, 'utf8'));
      catalogState = { ...cached, error: catalogState.error };
    } catch {}
    return catalogState;
  }
}

async function loadCatalogFromCache() {
  try {
    const text = await fs.readFile(CATALOG_CACHE_FILE, 'utf8');
    catalogState = JSON.parse(text);
  } catch {}
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

function simpleHash(input) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ymlUrl: YML_URL,
    categoryId: CATEGORY_ID,
    loadedAt: catalogState.loadedAt,
    products: catalogState.products.length,
    error: catalogState.error
  });
});

app.get('/api/products', async (req, res) => {
  if (!catalogState.products.length && !catalogState.error) {
    await refreshCatalog();
  }
  res.json({ ok: true, ...catalogState });
});

app.post('/api/refresh', async (req, res) => {
  const data = await refreshCatalog();
  res.json({ ok: !data.error, ...data });
});

app.post('/api/orders', async (req, res) => {
  const { items = [], customer = '', comment = '' } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, error: 'Пустой заказ' });
  }

  const normalizedItems = items
    .filter((item) => Number(item.quantity) > 0)
    .map((item) => ({
      id: String(item.id || ''),
      article: cleanText(item.article),
      name: cleanText(item.name),
      quantity: Number(item.quantity) || 0,
      price: Number(item.price) || 0,
      sum: (Number(item.quantity) || 0) * (Number(item.price) || 0)
    }))
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
    items: normalizedItems,
    totalQuantity: normalizedItems.reduce((sum, i) => sum + i.quantity, 0),
    totalSum: normalizedItems.reduce((sum, i) => sum + i.sum, 0)
  };

  orders.unshift(order);
  await writeOrders(orders);

  res.json({ ok: true, orderId: order.id });
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  const orders = await readOrders();
  res.json({ ok: true, orders });
});

app.get('/img', async (req, res) => {
  const imageUrl = String(req.query.url || '');
  if (!imageUrl) return res.status(400).send('No url');

  const key = simpleHash(imageUrl + `:${IMAGE_WIDTH}:${IMAGE_QUALITY}`);
  const cached = await readImageCache(key);
  if (cached) {
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(cached);
  }

  try {
    const response = await fetch(imageUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 Mobile Order Bot' }
    });
    if (!response.ok) throw new Error('Image fetch failed');

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

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
    res.redirect(imageUrl);
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

await ensureStorage();
await loadCatalogFromCache();
if (!catalogState.products.length) {
  refreshCatalog().catch(() => {});
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on :${PORT}`);
});
