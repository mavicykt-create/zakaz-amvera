import express from 'express';
import path from 'node:path';
import { createInbox } from './src/inbox/index.js';
import { remoteOrdersReader } from './src/inbox/remote-orders.js';

// Run this entry point as a separate Amvera application/domain with its own /data disk.
// Do not reverse-proxy the inbox under the public shop origin.
const app = express();
app.disable('x-powered-by');
const dataDir = path.resolve(process.env.DATA_DIR || '/data');
let readOrders;
try { readOrders = remoteOrdersReader(); }
catch { console.error('Order source configuration invalid. Check INBOX_ORDERS_URL.'); }
const inbox = await createInbox({ dataDir, readOrders });
app.get('/health', (req, res) => res.status(inbox.store ? 200 : 503).json({ ready: Boolean(inbox.store) }));
app.get('/', (req, res) => res.redirect('/inbox/'));
app.use('/inbox', inbox.router);
app.use((req, res) => res.sendStatus(404));
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Private inbox server started.'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  const force = setTimeout(() => process.exit(1), 10000); force.unref();
  server.close(async () => { await inbox.stop(); clearTimeout(force); process.exit(0); });
  void inbox.stop();
});
