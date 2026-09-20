import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import sharp from 'sharp';
import { isPublicIPv4, resolveImageSource, readImageSource } from '../src/image-security.js';

const repo = path.resolve(import.meta.dirname, '..');

test('image proxy blocks traversal, symlinks, raw-file fallback and unknown remote URLs; keeps catalog images working', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shop-security-'));
  const imageDir = path.join(directory, 'uploads', 'images');
  await fs.mkdir(imageDir, { recursive: true });
  const secret = 'TEST_PRIVATE_DATA_MUST_NOT_LEAK';
  await fs.writeFile(path.join(directory, 'private.png'), secret);
  await fs.writeFile(path.join(imageDir, 'broken.png'), secret);
  await fs.symlink(path.join(directory, 'private.png'), path.join(imageDir, 'escape.png'));
  await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toFile(path.join(imageDir, 'фото 1.png'));
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: repo, env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: directory, NODE_ENV: 'test', INBOX_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Shop startup timeout')), 10000);
    const done = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once('error', done);
    child.once('exit', code => { if (code !== null) done(new Error(`Shop exited: ${code}`)); });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('Server started')) done(); });
  });
  const url = value => `http://127.0.0.1:${port}/img?${new URLSearchParams({ url: value })}`;
  for (const value of [
    '/uploads/../../proc/self/environ', '/uploads/../inbox/state.enc',
    '/uploads/images/../../private.png', '/uploads/images/%2e%2e/%2e%2e/private.png',
    '/uploads/images/..%2f..%2fprivate.png', '/uploads/images/..\\..\\private.png',
    '/uploads/images/escape.png', '/uploads/images/%', '/uploads/images/private.svg',
    'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'https://arbitrary.example/image.png'
  ]) {
    const response = await fetch(url(value), { redirect: 'manual' });
    assert.equal(response.status, 400, value);
    assert.equal(response.headers.get('location'), null);
    assert.ok(!(await response.text()).includes(secret));
  }
  const broken = await fetch(url('/uploads/images/broken.png'));
  assert.equal(broken.status, 502);
  assert.ok(!(await broken.text()).includes(secret));
  const valid = await fetch(url('/uploads/images/%D1%84%D0%BE%D1%82%D0%BE%201.png'));
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get('content-type'), /^image\/webp/);
  assert.equal(valid.headers.get('x-content-type-options'), 'nosniff');
  const metadata = await sharp(Buffer.from(await valid.arrayBuffer())).metadata();
  assert.equal(metadata.format, 'webp');
});

test('remote catalog image fetch rejects private DNS and mixed answers before requesting a server', async () => {
  const imageUrl = 'https://images.example/photo.jpg';
  const source = await resolveImageSource(imageUrl, { sourceImagesDir: '/unused', products: [{ image: imageUrl }] });
  for (const records of [[{ address: '127.0.0.1' }], [{ address: '169.254.169.254' }], [{ address: '93.184.216.34' }, { address: '10.0.0.1' }]]) {
    await assert.rejects(readImageSource(source, { lookup: async () => records }), /not allowed/);
  }
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicIPv4(address), false, address);
  assert.equal(isPublicIPv4('93.184.216.34'), true);
  assert.equal(isPublicIPv4('8.8.8.8'), true);
});

test('legacy admin escapes order input and keeps its password out of the request URL', async () => {
  const html = await fs.readFile(path.join(repo, 'public/admin.html'), 'utf8');
  const script = html.match(/<script>([\s\S]+?)<\/script>/)[1];
  const nodes = Object.fromEntries(['adminStatus', 'orders', 'password', 'loadBtn'].map(id => [id, { value: 'test-only', addEventListener() {} }]));
  const attack = '<img src=x onerror="fetch(\'/inbox/api/board\')">';
  let request;
  const context = vm.createContext({ document: { getElementById: id => nodes[id] }, Intl, fetch: async (url, options) => { request = { url, options }; return { json: async () => ({ ok: true, orders: [{ id: attack, customer: attack, comment: attack, createdAt: '2026-01-01', totalQuantity: attack, totalSum: 10, items: [{ vendorCode: attack, name: attack, quantity: attack, cartPrice: 2, sum: 10 }] }] }) }; } });
  vm.runInContext(script, context);
  await vm.runInContext('loadOrders()', context);
  assert.equal(request.url, '/api/orders');
  assert.equal(request.options.headers['x-admin-password'], 'test-only');
  assert.equal(request.options.cache, 'no-store');
  assert.ok(!nodes.orders.innerHTML.includes('<img'));
  assert.ok(nodes.orders.innerHTML.includes('&lt;img'));
});

test('shop service worker never intercepts private board or admin API data', async () => {
  const script = await fs.readFile(path.join(repo, 'public/sw.js'), 'utf8');
  const listeners = {};
  const context = vm.createContext({ URL, self: { location: { origin: 'https://shop.example' }, addEventListener: (event, fn) => { listeners[event] = fn; } }, caches: { open() { throw new Error('Private response reached CacheStorage'); } } });
  vm.runInContext(script, context);
  for (const pathname of ['/inbox', '/inbox/', '/inbox/api/board', '/INBOX/api/attachments/abc', '/inbox/api/stream', '/api/orders', '/API/ORDERS', '/unknown-private-api']) {
    let intercepted = false;
    listeners.fetch({ request: { method: 'GET', url: `https://shop.example${pathname}`, mode: 'cors' }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, pathname);
  }
});
