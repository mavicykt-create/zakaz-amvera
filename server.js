import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStringPromise } from 'xml2js';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);

const YML_URL = process.env.YML_URL || 'https://milku.ru/site1/export-yandex-YML/';
const DISPLAY_PRICE_URL =
  process.env.DISPLAY_PRICE_URL || 'https://milku.ru/site1/export-yandex-yandexfeed/';

const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '12345');
const IMAGE_WIDTH = Number(process.env.IMAGE_WIDTH || 220);
const IMAGE_QUALITY = Number(process.env.IMAGE_QUALITY || 42);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);

const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const CATALOG_CACHE_FILE = path.join(DATA_DIR, 'catalog-cache.json');
const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'cache');

let catalogState = {
  loadedAt: null,
  categoryName: 'Весь ассортимент',
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

  try {
    await fs.access(ORDERS_FILE);
  } catch {
    await fs.writeFile(ORDERS_FILE, '[]', 'utf8');
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
  return cleanText(value);
}

function getParamValue(params, name) {
  const list = normalizeArray(params);
  const found = list.find((p) => cleanText(p?.$?.name) === name);
  if (!found) return '';
  if (typeof found === 'string') return cleanText(found);
  if (typeof found?._ === 'string') return cleanText(found._);
  return cleanText(found);
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

function extractShelfLife(params) {
  return parseDateToRu(getParamValue(params, 'Срок годности'));
}

function simpleHash(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 Mobile Order Bot' }
  });

  if (!response.ok) {
    throw new Error(`Не удалось загрузить XML: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function loadDisplayPrices() {
  const xml = await fetchText(DISPLAY_PRICE_URL);
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    mergeAttrs: false,
    trim: true
  });

  const shop = parsed?.yml_catalog?.shop;
  if (!shop) {
    throw new Error('Во втором фиде не найден блок yml_catalog.shop');
  }

  const offersRaw = normalizeArray(shop.offers?.offer);
  const map = new Map();

  for (const offer of offersRaw) {
    const vendorCode = firstText(offer.vendorCode);
    const displayPrice = Number(firstText(offer.price)) || 0;
    if (vendorCode) {
      map.set(vendorCode, displayPrice);
    }
  }

  return map;
}

function mapOffer(offer, displayPriceMap = new Map(), categoryName = '') {
  const vendorCode = firstText(offer.vendorCode);
  const cartPrice = Number(firstText(offer.price)) || 0;
  const displayPrice = vendorCode && displayPriceMap.has(vendorCode)
    ? Number(displayPriceMap.get(vendorCode)) || 0
    : 0;

  const categoryId = firstText(offer.categoryId);
  const picture = firstText(offer.picture);
  const name =
    firstText(offer.name) ||
    firstText(offer.model) ||
    `Товар ${firstText(offer?.$?.id) || ''}`;

  return {
    id:
      firstText(offer?.$?.id) ||
      vendorCode ||
      `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    vendorCode,
    name,
    image: picture,
    categoryId,
    categoryName,
    available: String(offer?.$?.available || 'true') !== 'false',
    shelfLife: extractShelfLife(offer.param),
    cartPrice,
    displayPrice
  };
}

async function refreshCatalog() {
  try {
    const [xml, displayPriceMap] = await Promise.all([
      fetchText(YML_URL),
      loadDisplayPrices()
    ]);

    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: false,
      trim: true
    });

    const shop = parsed?.yml_catalog?.shop;
    if (!shop) throw new Error('В основном фиде не найден блок yml_catalog.shop');

    const categories = normalizeArray(shop.categories?.category).map((c) => ({
      id: String(c?.$?.id || ''),
      name: typeof c === 'string' ? cleanText(c) : cleanText(c?._)
    }));

    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    const offersRaw = normalizeArray(shop.offers?.offer);

    const products = offersRaw.map((offer) => {
      const categoryId = firstText(offer.categoryId);
      return mapOffer(
        offer,
        displayPriceMap,
        categoryMap.get(categoryId) || `Категория ${categoryId || ''}`
      );
    });

    catalogState = {
      loadedAt: new Date().toISOString(),
      categoryName: 'Весь ассортимент',
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
  const loadedAtTs = catalogState.loadedAt ? new Date(catalogState.loadedAt).getTime() : 0;
  const isFresh = loadedAtTs ? Date.now() - loadedAtTs < CACHE_TTL_MS : false;

  res.json({
    ok: true,
    ymlUrl: YML_URL,
    displayPriceUrl: DISPLAY_PRICE_URL,
    loadedAt: catalogState.loadedAt,
    products: catalogState.products.length,
    error: catalogState.error,
    isFresh
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

  const key = simpleHash(`${imageUrl}:${IMAGE_WIDTH}:${IMAGE_QUALITY}`);
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
    res.send(optimized);
  } catch {
    res.redirect(imageUrl);
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

await ensureStorage();
await loadCatalogFromCache();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on :${PORT}`);
});

if (!catalogState.products.length) {
  refreshCatalog().catch((err) => {
    console.error('Catalog refresh failed:', err);
  });
}
