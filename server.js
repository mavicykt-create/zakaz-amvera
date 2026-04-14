cat > server.js << 'EOF'
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');

// =========================
// 🔒 BASE MIDDLEWARE
// =========================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// =========================
// 📦 STATIC FILES
// =========================
app.use(express.static(publicDir));

// =========================
// 📊 PRODUCTS API
// =========================
app.get('/api/products', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'data', 'catalog.json');

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'catalog not found' });
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    // ❗ КРИТИЧНО: отключаем кеш полностью
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });

    res.json(data);
  } catch (e) {
    console.error('products error', e);
    res.status(500).json({ error: 'server error' });
  }
});

// =========================
// 🧪 HEALTH CHECK
// =========================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// =========================
// 🚀 START
// =========================
app.listen(PORT, () => {
  console.log(`Server started on :${PORT}`);
});
EOF
