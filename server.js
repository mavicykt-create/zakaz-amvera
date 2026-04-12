import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = Number(process.env.PORT || 3000);

const DATA_DIR = './data';
const EXCHANGE_DIR = path.join(DATA_DIR, 'exchange');

const EXCHANGE_LOGIN = 'admin';
const EXCHANGE_PASSWORD = '12345';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ================== AUTH ==================
function parseAuth(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return null;

  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const [login, password] = decoded.split(':');

  return { login, password };
}

function requireAuth(req, res, next) {
  const creds = parseAuth(req);

  if (!creds || creds.login !== EXCHANGE_LOGIN || creds.password !== EXCHANGE_PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).send('failure\nUnauthorized');
  }

  next();
}

// ================== HELPERS ==================
async function resetDir() {
  await fs.rm(EXCHANGE_DIR, { recursive: true, force: true });
  await fs.mkdir(EXCHANGE_DIR, { recursive: true });
}

async function saveFile(filename, buffer) {
  const filePath = path.join(EXCHANGE_DIR, filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

// ================== 1C EXCHANGE ==================
async function handle1C(req, res) {
  const mode = (req.query.mode || '').toLowerCase();
  const type = (req.query.type || '').toLowerCase();

  console.log('1C:', mode, req.query.filename || '');

  if (!mode) {
    return res.send('success');
  }

  if (type && type !== 'catalog') {
    return res.send('failure\nwrong type');
  }

  if (mode === 'checkauth') {
    return res.send('success\nsessid\n123');
  }

  if (mode === 'init') {
    await resetDir();
    return res.send('zip=no\nfile_limit=200000000');
  }

  if (mode === 'file') {
    const filename = req.query.filename;

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    await saveFile(filename, buffer);

    console.log('saved:', filename, buffer.length);

    return res.send('success');
  }

  if (mode === 'import') {
    console.log('IMPORT START');

    // тут пока просто лог
    // позже можно вызвать парсинг

    return res.send('success');
  }

  return res.send('failure\nunknown mode');
}

// ================== ROUTE (ГЛАВНОЕ!) ==================
app.all(
  ['/1c_exchange.php', '/commerceml/1c_exchange.php', '/bitrix/admin/1c_exchange.php'],
  requireAuth,
  express.raw({ type: 'application/octet-stream', limit: '200mb' }),
  handle1C
);

// ================== TEST ==================
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Server started on', PORT);
});
