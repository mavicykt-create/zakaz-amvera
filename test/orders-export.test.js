import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import { createOrdersExportRouter } from '../src/inbox/orders-export.js';
import { remoteOrdersReader } from '../src/inbox/remote-orders.js';

test('read-only order export requires dedicated header token and excludes unknown fields', async t => {
  const token = crypto.randomBytes(32).toString('hex');
  let calls = 0;
  const app = express();
  app.use('/feed', createOrdersExportRouter({ env: { INBOX_ORDERS_READ_TOKEN: token }, readOrders: async () => { calls++; return [{ id: 'ORD-1', createdAt: '2026-09-20T00:00:00Z', customer: 'Test customer', secret: 'not exported', items: [{ id: 'p1', name: 'Test', quantity: 2, internalCost: 1, cartPrice: 5, sum: 10 }] }]; } }));
  app.use('/off', createOrdersExportRouter({ env: {}, readOrders: async () => { throw new Error('Should not run'); } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/feed?password=' + token)).status, 401);
  assert.equal((await fetch(base + '/feed', { headers: { 'x-admin-password': token } })).status, 401);
  assert.equal((await fetch(base + '/off', { headers: { Authorization: 'Bearer ' + token } })).status, 404);
  assert.equal(calls, 0);
  const headers = { Authorization: 'Bearer ' + token };
  assert.equal((await fetch(base + '/feed', { method: 'POST', headers })).status, 405);
  const response = await fetch(base + '/feed', { headers });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.source, 'zakaz-amvera'); assert.equal(data.orders[0].id, 'ORD-1');
  assert.equal(data.orders[0].secret, undefined); assert.equal(data.orders[0].items[0].internalCost, undefined);
});

test('remote order source is disabled without configuration and rejects unsafe URL configuration', () => {
  assert.equal(remoteOrdersReader({}), undefined);
  assert.throws(() => remoteOrdersReader({ INBOX_ORDERS_URL: 'http://shop.example.com/feed', INBOX_ORDERS_READ_TOKEN: 'key' }));
  assert.throws(() => remoteOrdersReader({ INBOX_ORDERS_URL: 'https://key:pass@shop.example.com/feed', INBOX_ORDERS_READ_TOKEN: 'key' }));
  assert.throws(() => remoteOrdersReader({ INBOX_ORDERS_URL: 'https://shop.example.com/feed?key=x', INBOX_ORDERS_READ_TOKEN: 'key' }));
});
