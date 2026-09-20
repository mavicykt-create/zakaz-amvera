import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGreen, normalizeFlexbe, normalizeOrder, startCollectors } from '../src/inbox/connectors.js';

const green = (extra = {}) => ({ typeWebhook: 'incomingMessageReceived', idMessage: 'MSG-1', timestamp: 1770000000,
  senderData: { chatId: '71234567890@c.us', sender: '71234567890@c.us', senderName: 'Клиент' },
  messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Заказ не готов?' } }, ...extra });
const order = (extra = {}) => ({ id: 'ORD-1', createdAt: '2026-09-20T09:00:00Z', customer: 'Магазин', phone: '+79999999999',
  comment: 'Самовывоз', items: [{ id: 'SKU-1', name: 'Конфеты', quantity: 2, cartPrice: 100, sum: 200 }], totalSum: 200, ...extra });
const flexbe = (extra = {}) => ({ event: 'lead', site: { id: 1, domain: 'example.ru' }, data: { id: 1414, num: 414,
  time: 1770000000, client: { name: 'Клиент', phone: '+79999999999' }, form_data: [{ name: 'Комментарий', value: 'Самовывоз' }],
  pay: { id: 15, summ: 200, status: { code: 0, name: 'Ожидает оплаты' } } }, ...extra });

test('Green: only inbound events become cards, same chat is a thread', () => {
  assert.equal(normalizeGreen({ typeWebhook: 'outgoingMessageStatus' }, 'whatsapp'), null);
  const first = normalizeGreen(green(), 'whatsapp');
  const next = normalizeGreen(green({ idMessage: 'MSG-2' }), 'whatsapp');
  assert.equal(first.externalId, 'MSG-1');
  assert.equal(first.threadId, next.threadId);
  assert.notEqual(first.externalId, next.externalId);
  assert.equal(first.text, 'Заказ не готов?');
  assert.equal(normalizeGreen(green(), 'max').source, 'max');
});

test('Green: media URL is HTTPS without account tokens; no raw payload is saved', () => {
  const media = url => green({ apiTokenInstance: 'secret', messageData: { typeMessage: 'documentMessage', fileMessageData: {
    downloadUrl: url, fileName: '../../счет.pdf', mimeType: 'application/pdf', fileSize: 20, caption: 'Счёт' } } });
  const publicAttachment = normalizeGreen(media('https://files.example.ru/счет.pdf'), 'whatsapp');
  assert.equal(publicAttachment.attachments[0].name, 'счет.pdf');
  assert.match(publicAttachment.attachments[0].url, /^https:/);
  for (const unsafe of ['http://files.example.ru/file', 'https://files.example.ru/file?token=secret', 'https://api.green-api.com/waInstance123/downloadFile/secret', 'https://user:secret@example.ru/file', 'https://127.0.0.1/file', 'javascript:alert(1)']) {
    const event = normalizeGreen(media(unsafe), 'whatsapp');
    assert.equal(event.attachments[0].url, undefined);
    assert.ok(event.metadata.attachmentNotice);
    assert.ok(!JSON.stringify(event).includes('secret'));
  }
});

test('Green: invalid required fields and overlong content fail without echoing input', () => {
  assert.throws(() => normalizeGreen(green(), 'mail'));
  assert.throws(() => normalizeGreen(green({ idMessage: {} }), 'whatsapp'));
  assert.throws(() => normalizeGreen(green({ senderData: { chatId: '' } }), 'whatsapp'));
  assert.throws(() => normalizeGreen(green({ messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'x'.repeat(64001) } } }), 'whatsapp'));
});

test('Flexbe: lead/pay payloads follow the documented wrapper, are idempotent and stay unverified', () => {
  const lead = normalizeFlexbe(flexbe());
  assert.equal(lead.source, 'flexbe');
  assert.equal(lead.threadId, '1414');
  assert.match(lead.text, /Комментарий: Самовывоз/);
  assert.equal(lead.externalId, normalizeFlexbe(JSON.parse(JSON.stringify(flexbe()))).externalId);
  const payload = flexbe(); payload.event = 'pay'; payload.data.pay.status.code = 2;
  const pay = normalizeFlexbe(payload);
  assert.equal(pay.threadId, lead.threadId);
  assert.notEqual(pay.externalId, lead.externalId);
  assert.equal(pay.metadata.paymentVerification, 'not_verified');
  assert.equal(pay.status, undefined);
  assert.match(pay.text, /Требуется сверка с банком/);
  assert.throws(() => normalizeFlexbe({ event: 'lead', data: {} }));
  assert.throws(() => normalizeFlexbe({ event: 'delete', data: { id: 1 } }));
});

test('Order snapshots group updates without writing a task status and dedupe equal content', () => {
  const original = order();
  const copy = structuredClone(original);
  const event = normalizeOrder(original);
  assert.deepEqual(original, copy);
  assert.equal(event.externalId, normalizeOrder({ totalSum: 200, ...order() }).externalId);
  const update = normalizeOrder(order({ status: 'assembled' }));
  assert.equal(event.threadId, update.threadId);
  assert.notEqual(event.externalId, update.externalId);
  assert.equal(update.status, undefined);
  assert.equal(update.metadata.orderStatus, 'assembled');
  assert.throws(() => normalizeOrder(order({ totalSum: Infinity })));
});

function memoryStore() {
  const checkpoints = new Map();
  const events = [];
  const connections = [];
  const files = [];
  const ids = new Set();
  return { checkpoints, events, connections, files,
    getCheckpoint(key) { return structuredClone(checkpoints.get(key)); },
    async setCheckpoint(key, value) { checkpoints.set(key, structuredClone(value)); },
    async setConnection(id, value) { connections.push({ id, ...value }); },
    async ingest(event) { const key = `${event.source}:${event.externalId}`; const duplicate = ids.has(key); ids.add(key); events.push(event); return { cardId: key, duplicate }; },
    async saveAttachment(buffer, info) { files.push({ buffer, ...info }); return { id: `file-${files.length}`, size: buffer.length, ...info }; }
  };
}

async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Collector did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const mailEnv = { INBOX_IMAP_USER: 'inbox@example.ru', INBOX_IMAP_PASSWORD: 'SECRET-APP-PASSWORD', INBOX_MAIL_SINCE: '2026-09-20' };
function rawMail({ id = 'message-1', from = 'bank@example.ru', subject = 'Уведомление', body = 'Поступил перевод', type = 'text/plain' } = {}) {
  return Buffer.from(`From: ${from}\r\nTo: inbox@example.ru\r\nMessage-ID: <${id}@example.ru>\r\nDate: Sun, 20 Sep 2026 09:00:00 +0000\r\nSubject: ${subject}\r\nContent-Type: ${type}; charset=utf-8\r\n\r\n${body}`);
}
function mockImap({ messages, validity = '123', observations = [] }) {
  return options => {
    observations.push({ type: 'options', options });
    return {
      mailbox: { uidValidity: validity }, on() {}, async connect() {}, async logout() {}, close() {},
      async mailboxOpen(folder, options) { observations.push({ type: 'open', folder, options }); },
      async search(query, options) { observations.push({ type: 'search', query, options }); return messages.map(v => v.uid).reverse(); },
      async fetchOne(uid, query, options) {
        observations.push({ type: 'fetch', uid, query, options });
        const item = messages.find(v => v.uid === uid);
        if (!item) return false;
        if (query.source) return { uid, source: item.source };
        return { uid, size: item.size ?? item.source.length, envelope: item.envelope || { messageId: `<message-${uid}@example.ru>`, from: [{ address: 'bank@example.ru' }], subject: 'Уведомление' } };
      }
    };
  };
}

test('Absent credentials show not configured and never instantiate IMAP', async t => {
  const store = memoryStore();
  let polls = 0;
  const stop = startCollectors({ store, env: {}, readOrders: async () => { polls++; return [order()]; },
    createImapClient: () => assert.fail('Network must not start'), pollIntervalMs: 5 });
  t.after(stop);
  await until(() => polls >= 2);
  assert.ok(store.connections.some(c => c.id === 'mail' && c.status === 'not_configured'));
  assert.ok(store.connections.some(c => c.id === 'zakaz-amvera' && c.status === 'ok'));
  assert.equal(new Set(store.events.map(e => e.externalId)).size, 1);
  await stop();
  const finalPolls = polls;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(polls, finalPolls);
});

test('Malformed historical order does not block newer orders; import runs oldest first', async t => {
  const store = memoryStore();
  const stop = startCollectors({ store, env: {}, readOrders: async () => [order({ id: 'NEW', createdAt: '2026-09-20' }), {}, order({ id: 'OLD', createdAt: '2026-09-19' })], pollIntervalMs: 1000 });
  t.after(stop);
  await until(() => store.connections.some(c => c.id === 'zakaz-amvera'));
  assert.deepEqual(store.events.map(event => event.threadId), ['OLD', 'NEW']);
  assert.equal(store.connections.find(c => c.id === 'zakaz-amvera').status, 'error');
  assert.match(store.connections.find(c => c.id === 'zakaz-amvera').message, /Остальные заказы обработаны/);
});

test('IMAP uses TLS, read-only, bounded fetch, exact sender allowlist and checkpoint after saved event', async t => {
  const store = memoryStore(); const observations = [];
  const messages = [{ uid: 10, source: rawMail() }, { uid: 11, source: rawMail({ id: 'message-2', from: 'spoof-bank@example.ru' }) }];
  const stop = startCollectors({ store, env: { ...mailEnv, INBOX_SBER_SENDERS: 'BANK@EXAMPLE.RU' }, readOrders: async () => [],
    createImapClient: mockImap({ messages, observations }), pollIntervalMs: 1000 });
  t.after(stop);
  await until(() => store.connections.some(c => c.id === 'mail' && c.status === 'ok'));
  assert.equal(observations[0].options.secure, true);
  assert.equal(observations[0].options.port, 993);
  assert.equal(observations[0].options.tls.rejectUnauthorized, true);
  assert.equal(observations.find(v => v.type === 'open').options.readOnly, true);
  assert.ok(observations.filter(v => v.query?.source).every(v => v.query.source.maxLength === 20 * 1024 * 1024 + 1));
  assert.deepEqual(store.events.map(e => e.source), ['sber', 'mail']);
  assert.equal(store.events[0].metadata.paymentVerification, 'not_verified');
  assert.match(store.events[0].text, /Операция не подтверждена/);
  assert.equal([...store.checkpoints.values()][0].lastUid, 11);
  assert.match(store.connections.findLast(c => c.id === 'mail').message, /Более ранние письма не загружаются/);
});

test('A failed event save retries its UID before later mail and never leaks secrets in connection errors', async t => {
  const store = memoryStore(); const observations = [];
  const originalIngest = store.ingest.bind(store); let attempts = 0;
  store.ingest = async event => { attempts++; if (attempts === 1) throw new Error(mailEnv.INBOX_IMAP_PASSWORD); return originalIngest(event); };
  const stop = startCollectors({ store, env: mailEnv, readOrders: async () => [], pollIntervalMs: 10,
    createImapClient: mockImap({ messages: [{ uid: 10, source: rawMail() }, { uid: 11, source: rawMail({ id: 'second' }) }], observations }) });
  t.after(stop);
  await until(() => [...store.checkpoints.values()][0]?.lastUid === 11);
  assert.equal(attempts, 3);
  assert.equal(store.events.length, 2);
  assert.ok(store.connections.some(c => c.id === 'mail' && c.status === 'error'));
  assert.ok(!JSON.stringify(store.connections).includes('SECRET-APP-PASSWORD'));
  assert.equal(observations.filter(v => v.type === 'fetch' && v.query.envelope).map(v => v.uid).join(','), '10,10,11');
});

test('UIDVALIDITY reset searches the original starting date and dedupes by MIME message ID', async t => {
  const store = memoryStore();
  let stop = startCollectors({ store, env: mailEnv, readOrders: async () => [], pollIntervalMs: 1000,
    createImapClient: mockImap({ messages: [{ uid: 40, source: rawMail() }] }) });
  t.after(() => stop());
  await until(() => [...store.checkpoints.values()][0]?.lastUid === 40);
  await stop();
  const firstExternalId = store.events[0].externalId; const observations = [];
  stop = startCollectors({ store, env: { ...mailEnv, INBOX_MAIL_SINCE: '2030-01-01' }, readOrders: async () => [], pollIntervalMs: 1000,
    createImapClient: mockImap({ messages: [{ uid: 1, source: rawMail() }], validity: '456', observations }) });
  await until(() => [...store.checkpoints.values()][0]?.uidValidity === '456' && [...store.checkpoints.values()][0]?.lastUid === 1);
  assert.equal(store.events[1].externalId, firstExternalId);
  assert.equal(observations.find(v => v.type === 'search').query.since.toISOString(), '2026-09-20T00:00:00.000Z');
  assert.equal(observations.find(v => v.type === 'search').query.uid, undefined);
});

test('Oversized mail is recorded explicitly without fetching its body or losing later messages', async t => {
  const store = memoryStore(); const observations = [];
  const stop = startCollectors({ store, env: mailEnv, readOrders: async () => [], pollIntervalMs: 1000,
    createImapClient: mockImap({ messages: [{ uid: 1, source: Buffer.alloc(0), size: 21 * 1024 * 1024 }, { uid: 2, source: rawMail({ id: 'normal' }) }], observations }) });
  t.after(stop);
  await until(() => [...store.checkpoints.values()][0]?.lastUid === 2);
  assert.equal(store.events[0].metadata.bodyOmitted, true);
  assert.match(store.events[0].text, /20 МБ/);
  assert.ok(!observations.some(v => v.uid === 1 && v.query.source));
  assert.equal(store.events.length, 2);
});

test('HTML-only mail becomes plain text, not active HTML', async t => {
  const store = memoryStore();
  const stop = startCollectors({ store, env: mailEnv, readOrders: async () => [], pollIntervalMs: 1000,
    createImapClient: mockImap({ messages: [{ uid: 1, source: rawMail({ type: 'text/html', body: '<p>Новый заказ</p><script>alert(1)</script>' }) }] }) });
  t.after(stop);
  await until(() => store.events.length === 1);
  assert.match(store.events[0].text, /Новый заказ/);
  assert.ok(!store.events[0].text.includes('<script>'));
  assert.equal(store.events[0].source, 'mail');
});

test('MIME attachments are stored with a safe filename; a save failure does not acknowledge the mail', async t => {
  const store = memoryStore();
  const body = Buffer.from('From: sender@example.ru\r\nMessage-ID: <attachment@example.ru>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test"\r\n\r\n--test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nСчёт во вложении\r\n--test\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="../../invoice.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjc=\r\n--test--');
  let attempts = 0;
  const save = store.saveAttachment.bind(store);
  store.saveAttachment = async (...args) => { if (++attempts === 1) throw new Error('disk failure'); return save(...args); };
  const stop = startCollectors({ store, env: mailEnv, readOrders: async () => [], pollIntervalMs: 10,
    createImapClient: mockImap({ messages: [{ uid: 1, source: body }] }) });
  t.after(stop);
  await until(() => [...store.checkpoints.values()][0]?.lastUid === 1);
  assert.equal(attempts, 2);
  assert.equal(store.events.length, 1);
  assert.equal(store.files[0].name, 'invoice.pdf');
  assert.equal(store.files[0].contentType, 'application/pdf');
  assert.equal(store.events[0].attachments[0].id, 'file-1');
  assert.ok(store.connections.some(c => c.id === 'mail' && c.status === 'error'));
});

const flexbeEnv = { INBOX_FLEXBE_API_URL: 'https://shop.example.ru/mod/api/', INBOX_FLEXBE_API_KEY: 'PRIVATE-FLEXBE-KEY', INBOX_FLEXBE_SINCE: '2020-01-01' };
const apiResponse = (leads, options = {}) => new Response(JSON.stringify({ status: 1, data: { leads } }), { status: 200, ...options });
const leadPage = count => Array.from({ length: count }, (_, index) => ({ ...flexbe().data, id: String(index + 1), num: index + 1 }));

test('Flexbe reconciliation uses documented POST parameters, pagination and the same lead thread as webhooks', async t => {
  const store = memoryStore(); const requests = [];
  const leads = leadPage(101);
  const stop = startCollectors({ store, env: flexbeEnv, readOrders: async () => [], flexbePageDelayMs: 1,
    fetchImpl: async (url, options) => {
      requests.push({ url, options, fields: Object.fromEntries(options.body) });
      const start = Number(options.body.get('start'));
      return apiResponse(Object.fromEntries(leads.slice(start, start + 100).map(lead => [lead.id, lead])));
    } });
  t.after(stop);
  await until(() => store.connections.some(c => c.id === 'flexbe' && c.status === 'ok'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, flexbeEnv.INBOX_FLEXBE_API_URL);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].fields.api_key, 'PRIVATE-FLEXBE-KEY');
  assert.equal(requests[0].fields.method, 'getLeads');
  assert.equal(requests[0].fields.count, '100');
  assert.equal(requests[0].fields.date_from, String(Date.parse('2020-01-01') / 1000));
  assert.equal(requests[0].fields.date_to, requests[1].fields.date_to);
  assert.deepEqual(requests.map(r => r.fields.start), ['0', '100']);
  assert.equal(store.events.length, 101);
  const sameWebhook = normalizeFlexbe({ event: 'lead', data: leads[0] });
  assert.equal(store.events[0].threadId, sameWebhook.threadId);
  assert.equal(store.events[0].externalId, sameWebhook.externalId);
  assert.equal([...store.checkpoints.values()][0].cursor, Number(requests[0].fields.date_to));
  assert.ok(!JSON.stringify(store.connections).includes('PRIVATE-FLEXBE-KEY'));
});

test('Flexbe failure on a later page keeps the cursor; restart retries persisted pages safely', async t => {
  const store = memoryStore(); const leads = leadPage(100); let calls = 0;
  const stop = startCollectors({ store, env: flexbeEnv, readOrders: async () => [], flexbePageDelayMs: 1, flexbePollIntervalMs: 10,
    fetchImpl: async (url, options) => {
      calls++;
      if (calls === 2) {
        assert.equal([...store.checkpoints.values()][0].cursor, 0);
        assert.equal(store.events.length, 100);
        return new Response('temporarily unavailable', { status: 503 });
      }
      return apiResponse(Number(options.body.get('start')) === 0 ? leads : []);
    } });
  t.after(stop);
  await until(() => [...store.checkpoints.values()][0]?.cursor > 0);
  assert.equal(calls, 4);
  assert.equal(store.events.length, 200);
  assert.equal(new Set(store.events.map(event => event.externalId)).size, 100);
  assert.ok(store.connections.some(c => c.id === 'flexbe' && c.status === 'error'));
});

test('Flexbe persisted cursor uses a seven-day overlap and survives configuration date changes', async t => {
  const store = memoryStore();
  let stop = startCollectors({ store, env: flexbeEnv, readOrders: async () => [], fetchImpl: async () => apiResponse([]) });
  t.after(() => stop());
  await until(() => [...store.checkpoints.values()][0]?.cursor > 0);
  await stop();
  const checkpoint = [...store.checkpoints.values()][0]; let requestedFrom;
  stop = startCollectors({ store, env: { ...flexbeEnv, INBOX_FLEXBE_SINCE: '2040-01-01' }, readOrders: async () => [], fetchImpl: async (url, options) => {
    requestedFrom = Number(options.body.get('date_from')); return apiResponse([]);
  } });
  await until(() => requestedFrom !== undefined);
  assert.equal(requestedFrom, checkpoint.cursor - 7 * 24 * 60 * 60);
  assert.equal([...store.checkpoints.values()][0].since, checkpoint.since);
});

test('Flexbe invalid destinations never receive the credential and incomplete settings stay explicit', async () => {
  for (const url of ['http://shop.example.ru/mod/api/', 'https://user:pass@shop.example.ru/mod/api/', 'https://shop.example.ru/mod/api/?api_key=x', 'https://shop.example.ru/mod/api/#x', 'https://127.0.0.1/mod/api/', 'https://shop.example.ru/other', 'https://shop.example.ru:8443/mod/api/']) {
    const store = memoryStore();
    const stop = startCollectors({ store, env: { ...flexbeEnv, INBOX_FLEXBE_API_URL: url }, readOrders: async () => [],
      fetchImpl: async () => assert.fail('Credential must not be sent') });
    await until(() => store.connections.some(c => c.id === 'flexbe'));
    await stop();
    assert.equal(store.connections.find(c => c.id === 'flexbe').status, 'error');
  }
});

test('Flexbe shutdown aborts a pending API request and startup returns immediately', async () => {
  const store = memoryStore(); let signal;
  const stop = startCollectors({ store, env: flexbeEnv, readOrders: async () => [], fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  assert.equal(typeof stop, 'function');
  await until(() => signal);
  await stop();
  assert.equal(signal.aborted, true);
  assert.equal([...store.checkpoints.values()][0].cursor, 0);
});
