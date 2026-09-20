import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import { InboxStore } from '../src/inbox/store.js';
import { hashPassword, verifyPassword, base32Encode, totp, verifyTotp, inboxConfig } from '../src/inbox/security.js';
import { createInbox } from '../src/inbox/index.js';

const secret = base32Encode(Buffer.from('12345678901234567890'));
const password = 'Test-only owner password long enough';
const passwordHash = await hashPassword(password);
const origin = 'http://127.0.0.1:45678';
const env = { NODE_ENV: 'development', INBOX_ENABLED: 'true', INBOX_ORIGIN: origin, INBOX_PASSWORD_HASH: passwordHash, INBOX_TOTP_SECRET: secret, INBOX_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), INBOX_WHATSAPP_WEBHOOK_TOKEN: crypto.randomBytes(32).toString('hex'), INBOX_WHATSAPP_INSTANCE_ID: '123456' };

test('password and TOTP: RFC6238 known vector, wrong/expired/replayed codes rejected', async () => {
  assert.equal(totp(secret, 1), '287082'); // RFC6238 SHA-1 vector 59s, last six digits.
  assert.equal(verifyTotp(secret, '287082', -1, 59000), 1);
  assert.equal(verifyTotp(secret, '287082', 1, 59000), null);
  assert.equal(verifyTotp(secret, '287082', -1, 300000), null);
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword('bad', passwordHash), false);
  assert.throws(() => inboxConfig({ ...env, NODE_ENV: 'production' }), /HTTPS/);
  assert.throws(() => inboxConfig({ ...env, INBOX_ENCRYPTION_KEY: '' }));
});

test('durable dedup across restart, status preservation, encrypted attachments and fail-closed corruption', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-store-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const store = await new InboxStore(dir, key).open();
  const event = { source: 'whatsapp', externalId: 'message-one', threadId: 'chat-one', title: 'Client private title', text: 'Sensitive incoming text', sender: 'Client' };
  const results = await Promise.all(Array.from({ length: 12 }, () => store.ingest(event)));
  assert.equal(results.filter(x => !x.duplicate).length, 1);
  const id = results[0].cardId;
  await store.update(id, { status: 'done', dueAt: '2026-12-01T04:00:00Z' });
  const attachment = await store.saveAttachment(Buffer.from('Sensitive attachment'), { name: '../private.txt', contentType: 'text/plain' });
  await store.ingest({ ...event, externalId: 'message-two', attachments: [attachment] });
  const restored = await new InboxStore(dir, key).open();
  assert.equal((await restored.ingest(event)).duplicate, true);
  assert.equal(restored.detail(id).events.length, 2);
  assert.equal(restored.detail(id).card.status, 'done');
  assert.equal(restored.detail(id).card.unread, true);
  assert.equal((await restored.readAttachment(attachment.id)).data.toString(), 'Sensitive attachment');
  assert.equal(await restored.readAttachment('../../etc/passwd'), null);
  const raw = await fs.readFile(path.join(dir, 'state.enc'));
  assert.equal(raw.includes(Buffer.from('Sensitive incoming text')), false);
  assert.equal(raw.includes(Buffer.from('Client private title')), false);
  await assert.rejects(new InboxStore(dir, crypto.randomBytes(32)).open(), /Хранилище/);
  raw[raw.length - 1] ^= 1; await fs.writeFile(path.join(dir, 'state.enc'), raw);
  await assert.rejects(new InboxStore(dir, key).open(), /Хранилище/);
});

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-http-'));
  const inbox = await createInbox({ env: { ...env, ...options }, dataDir: dir, collectors: false });
  const app = express(); app.use('/inbox', inbox.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/inbox`;
  t.after(async () => { await inbox.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const request = (route, init = {}) => fetch(base + route, { ...init, headers: { Origin: origin, 'Content-Type': 'application/json', ...init.headers } });
  return { inbox, request };
}
async function login(request) {
  const response = await request('/api/login', { method: 'POST', body: JSON.stringify({ password, code: totp(secret, Math.floor(Date.now() / 30000)) }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\/inbox/);
  return { cookie: cookie.split(';')[0], csrf: (await response.json()).csrfToken };
}

test('anonymous APIs denied, browser mutations require session+CSRF+correct origin, logout invalidates session', async t => {
  const { request } = await fixture(t);
  for (const route of ['/api/session', '/api/board', '/api/cards/unknown', '/api/attachments/test', '/api/stream']) assert.equal((await request(route)).status, 401);
  const cross = await request('/api/login', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }); assert.equal(cross.status, 403);
  const session = await login(request);
  const body = JSON.stringify({ title: '<img src=x onerror=alert(1)>', text: 'Remember', dueAt: '2026-12-01T03:00:00Z' });
  assert.equal((await request('/api/cards', { method: 'POST', headers: { Cookie: session.cookie }, body })).status, 403);
  const headers = { Cookie: session.cookie, 'x-csrf-token': session.csrf };
  assert.equal((await request('/api/cards', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body })).status, 403);
  const created = await request('/api/cards', { method: 'POST', headers, body }); assert.equal(created.status, 201);
  const card = (await created.json()).card;
  const board = await (await request('/api/board', { headers })).json(); assert.equal(board.cards.length, 1);
  assert.equal(board.cards[0].title, '<img src=x onerror=alert(1)>');
  const invalid = await request(`/api/cards/${card.id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'paid' }) }); assert.equal(invalid.status, 400);
  const replay = await request('/api/login', { method: 'POST', body: JSON.stringify({ password, code: totp(secret, Math.floor(Date.now() / 30000)) }) }); assert.equal(replay.status, 401);
  assert.equal((await request('/api/logout', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await request('/api/board', { headers })).status, 401);
});

test('callback bearer+instance required; duplicate retry yields one event; disk failure not acknowledged', async t => {
  const { request, inbox } = await fixture(t);
  const data = { typeWebhook: 'incomingMessageReceived', idMessage: 'callback1', instanceData: { idInstance: 123456 }, timestamp: 1790000000, senderData: { chatId: '70000000000@c.us', sender: 'Client' }, messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Order question' } } };
  const init = { method: 'POST', body: JSON.stringify(data) };
  assert.equal((await request('/hooks/whatsapp', init)).status, 401);
  init.headers = { Authorization: `Bearer ${env.INBOX_WHATSAPP_WEBHOOK_TOKEN}` };
  assert.equal((await request('/hooks/whatsapp', { ...init, body: JSON.stringify({ ...data, instanceData: { idInstance: 999 } }) })).status, 400);
  for (let i = 0; i < 3; i++) assert.equal((await request('/hooks/whatsapp', init)).status, 200);
  assert.equal(inbox.store.board().cards[0].eventCount, 1);
  const persist = inbox.store.persist;
  inbox.store.persist = async () => { throw new Error('disk unavailable'); };
  const second = { ...init, body: JSON.stringify({ ...data, idMessage: 'callback2' }) };
  assert.equal((await request('/hooks/whatsapp', second)).status, 500);
  assert.equal(inbox.store.board().cards[0].eventCount, 1);
  inbox.store.persist = persist;
  assert.equal((await request('/hooks/whatsapp', second)).status, 200);
  assert.equal(inbox.store.board().cards[0].eventCount, 2);
});

test('board disabled or missing second factor fails closed', async t => {
  const { request } = await fixture(t, { INBOX_TOTP_SECRET: '' });
  assert.equal((await request('/api/session')).status, 503);
  assert.equal((await request('/api/board')).status, 503);
  assert.equal((await request('/hooks/whatsapp', { method: 'POST', body: '{}' })).status, 503);
});

test('Flexbe nested form callback accepted only with configured callback secret', async t => {
  const token = crypto.randomBytes(32).toString('hex');
  const { request, inbox } = await fixture(t, { INBOX_FLEXBE_WEBHOOK_TOKEN: token });
  const body = new URLSearchParams({ event: 'lead', 'data[id]': '1001', 'data[client][name]': 'Test client', 'data[form_data][0][name]': 'Question', 'data[form_data][0][value]': 'Order' });
  assert.equal((await request('/hooks/flexbe/wrong', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).status, 401);
  const result = await request(`/hooks/flexbe/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  assert.equal(result.status, 200);
  assert.equal(inbox.store.board().cards[0].sender, 'Test client');
});
