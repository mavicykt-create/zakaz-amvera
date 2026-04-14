import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import AdmZip from 'adm-zip';
import xml2js from 'xml2js';
import multer from 'multer';

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(publicDir));

const upload = multer({ dest: uploadsDir });

app.post('/api/commerceml/upload-zip', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'file not uploaded' });
    }

    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();

    let offersXml = null;

    for (const entry of entries) {
      const name = entry.entryName.toLowerCase();
      if (name.endsWith('offers.xml') || name.includes('offers.xml')) {
        offersXml = entry.getData().toString('utf8');
        break;
      }
    }

    if (!offersXml) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'offers.xml not found in zip' });
    }

    const parsed = await xml2js.parseStringPromise(offersXml, {
      explicitArray: true,
      trim: true
    });

    const ci = parsed['КоммерческаяИнформация'];
    const packet = ci?.['ПакетПредложений']?.[0];
    const offers = packet?.['Предложения']?.[0]?.['Предложение'] || [];

    const products = offers.map((o) => {
      const id = o?.['Ид']?.[0] || '';
      const name = o?.['Наименование']?.[0] || '';
      const price =
        o?.['Цены']?.[0]?.['Цена']?.[0]?.['ЦенаЗаЕдиницу']?.[0] || '0';

      return {
        id,
        name,
        price: Number(price) || 0
      };
    });

    const catalog = {
      products,
      updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(dataDir, 'catalog.json'),
      JSON.stringify(catalog, null, 2),
      'utf8'
    );

    fs.unlinkSync(req.file.path);

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });

    return res.json({
      success: true,
      count: products.length,
      updatedAt: catalog.updatedAt
    });
  } catch (e) {
    console.error('upload error', e);
    return res.status(500).json({ error: 'upload error' });
  }
});

app.get('/api/products', (req, res) => {
  try {
    const filePath = path.join(dataDir, 'catalog.json');

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });

    if (!fs.existsSync(filePath)) {
      return res.json({ products: [], updatedAt: null });
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);

    return res.json(data);
  } catch (e) {
    console.error('products error', e);
    return res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server started on :${PORT}`);
});
