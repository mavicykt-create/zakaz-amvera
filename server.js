cat > server.js << 'EOF'
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(publicDir));

const upload = multer({ dest: 'uploads/' });

// =========================
// 📥 ЗАГРУЗКА ZIP
// =========================
app.post('/api/commerceml/upload-zip', upload.single('file'), async (req, res) => {
  try {
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();

    let offersXml = null;

    for (const entry of entries) {
      if (entry.entryName.includes('offers.xml')) {
        offersXml = entry.getData().toString('utf8');
      }
    }

    if (!offersXml) {
      return res.status(400).json({ error: 'offers.xml not found' });
    }

    const parsed = await xml2js.parseStringPromise(offersXml);

    const offers = parsed['КоммерческаяИнформация']['ПакетПредложений'][0]['Предложения'][0]['Предложение'];

    const products = offers.map(o => ({
      id: o['Ид'][0],
      name: o['Наименование'][0],
      price: o['Цены'][0]['Цена'][0]['ЦенаЗаЕдиницу'][0]
    }));

    const catalog = {
      products,
      updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(dataDir, 'catalog.json'),
      JSON.stringify(catalog, null, 2)
    );

    res.json({ success: true, count: products.length });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'upload error' });
  }
});

// =========================
// 📊 PRODUCTS
// =========================
app.get('/api/products', (req, res) => {
  try {
    const filePath = path.join(dataDir, 'catalog.json');

    if (!fs.existsSync(filePath)) {
      return res.json({ products: [] });
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    res.set({
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server started on :${PORT}`);
});
EOF
