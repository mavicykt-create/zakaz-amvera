import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const MAX_TEXT = 64_000;
const MAX_MAIL = 20 * 1024 * 1024;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const POLL_MS = 30_000;
const FLEXBE_POLL_MS = 60_000;
const FLEXBE_PAGE_SIZE = 100;
const FLEXBE_OVERLAP_SECONDS = 7 * 24 * 60 * 60;

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Некорректное поле: ${field}`);
  return value;
}

function string(value, field, max = 500, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`Отсутствует поле: ${field}`);
    return '';
  }
  if (!['string', 'number'].includes(typeof value)) throw new Error(`Некорректное поле: ${field}`);
  const result = String(value).trim();
  if (result.length > max || /\u0000/.test(result) || (required && !result)) throw new Error(`Некорректное поле: ${field}`);
  return result;
}

function date(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const millis = typeof value === 'number' || /^\d{9,13}$/.test(String(value))
    ? Number(value) * (Number(value) < 1e12 ? 1000 : 1)
    : value;
  const result = new Date(millis);
  if (!Number.isFinite(result.getTime())) throw new Error(`Некорректная дата: ${field}`);
  return result.toISOString();
}

// Hash key order independently; never include credentials from unknown payload fields.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function hash(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
}

function filename(value) {
  return String(value || 'Вложение').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'Вложение';
}

function safeMediaUrl(value) {
  if (!value) return undefined;
  string(value, 'downloadUrl', 2048);
  let url;
  try { url = new URL(value); } catch { return undefined; }
  // Signed URLs and API routes can contain account tokens. Do not persist them.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /waInstance|apiToken|access[_-]?token/i.test(url.pathname)) return undefined;
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname) || !url.hostname.includes('.')) return undefined;
  return url.href;
}

/** Official GREEN-API incomingMessageReceived format; never changes an instance. */
export function normalizeGreen(body, source) {
  object(body, 'body');
  if (!['whatsapp', 'max'].includes(source)) throw new Error('Неизвестный источник GREEN-API');
  const webhook = string(body.typeWebhook, 'typeWebhook', 100, true);
  if (webhook !== 'incomingMessageReceived') return null;
  const externalId = string(body.idMessage, 'idMessage', 256, true);
  const senderData = object(body.senderData, 'senderData');
  const threadId = string(senderData.chatId, 'chatId', 256, true);
  const senderId = string(senderData.sender, 'sender', 256);
  const sender = string(senderData.senderContactName || senderData.senderName || senderId || threadId, 'senderName', 500, true);
  const chatName = string(senderData.chatName, 'chatName', 500);
  const data = object(body.messageData, 'messageData');
  const messageType = string(data.typeMessage, 'typeMessage', 100, true);
  let text = '';
  const attachments = [];
  const metadata = { messageType, senderId };
  if (messageType === 'textMessage') {
    text = string(object(data.textMessageData, 'textMessageData').textMessage, 'textMessage', MAX_TEXT, true);
  } else if (messageType === 'extendedTextMessage') {
    text = string(object(data.extendedTextMessageData, 'extendedTextMessageData').text, 'text', MAX_TEXT, true);
  } else if (data.fileMessageData) {
    const file = object(data.fileMessageData, 'fileMessageData');
    const name = filename(string(file.fileName, 'fileName', 1000));
    const contentType = string(file.mimeType, 'mimeType', 200) || 'application/octet-stream';
    const size = Number(file.fileSize || 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Некорректный размер вложения');
    const url = safeMediaUrl(file.downloadUrl);
    attachments.push({ id: `remote-${hash([source, externalId, name]).slice(0, 32)}`, name, size, contentType, ...(url ? { url } : {}) });
    text = string(file.caption, 'caption', MAX_TEXT) || `Вложение: ${name}`;
    metadata.attachmentStorage = 'remote';
    metadata.attachmentNotice = url
      ? 'Вложение хранится у провайдера мессенджера; ссылка может истечь. Если она не работает, откройте оригинал в мессенджере.'
      : 'Ссылка недоступна или содержит секретные параметры. Откройте вложение в мессенджере.';
    text += `\n\n${metadata.attachmentNotice}`;
  } else {
    text = `Сообщение типа «${messageType}». Откройте оригинал в мессенджере.`;
    metadata.contentNotice = 'Формат сообщения пока не отображается полностью.';
  }
  return { source, externalId, threadId, title: (chatName || sender).slice(0, 250), sender, text,
    occurredAt: date(body.timestamp, 'timestamp'), attachments, metadata };
}

function amount(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 1e15) throw new Error(`Некорректная сумма: ${field}`);
  return result;
}

/** https://help.flexbe.ru/api-documentation/ — event, site, data. */
export function normalizeFlexbe(body) {
  object(body, 'body');
  const event = string(body.event, 'event', 100, true);
  if (!['lead', 'pay'].includes(event)) throw new Error('Неизвестное событие Flexbe');
  const data = object(body.data, 'data');
  const id = string(data.id, 'data.id', 128, true);
  const num = string(data.num, 'data.num', 128) || id;
  const client = data.client ? object(data.client, 'client') : {};
  const customer = string(client.name, 'client.name', 500);
  const phone = string(client.phone, 'client.phone', 100);
  const email = string(client.email, 'client.email', 320);
  const note = string(data.note, 'note', 10_000);
  const form = string(data.form_name, 'form_name', 500);
  const fields = [];
  if (data.form_data !== undefined && data.form_data !== null) {
    if (typeof data.form_data !== 'object') throw new Error('Некорректное поле: form_data');
    const entries = Object.entries(data.form_data);
    if (entries.length > 200) throw new Error('Слишком много полей заявки');
    for (const [key, value] of entries) {
      const field = value && typeof value === 'object' && !Array.isArray(value) ? value : { name: key, value };
      const name = string(field.name || field.label || key, 'form_data.name', 500);
      const raw = Array.isArray(field.value) ? field.value.map(v => string(v, 'form_data.value', 2000)).join(', ') : field.value;
      fields.push(`${name}: ${string(raw, 'form_data.value', 5000)}`);
    }
  }
  const pay = data.pay ? object(data.pay, 'pay') : {};
  const payStatus = pay.status && typeof pay.status === 'object' ? pay.status.code : pay.status;
  const status = data.status && typeof data.status === 'object' ? data.status.code : data.status;
  const metadata = { leadId: id, event, customer, phone, email, form,
    leadStatus: string(status, 'status', 100), paymentStatusReported: string(payStatus, 'pay.status', 100),
    paymentId: string(pay.id, 'pay.id', 128), amountReported: amount(pay.summ, 'pay.summ'),
    paymentTest: pay.test === true || pay.test === 1 || pay.test === '1',
    paymentVerification: 'not_verified' };
  const text = [event === 'pay' ? 'Flexbe сообщает о событии оплаты или ошибке платежа. Требуется сверка с банком.' : 'Новая заявка Flexbe.',
    customer, phone, email, form, ...fields, note,
    metadata.amountReported !== undefined ? `Сумма по данным Flexbe: ${metadata.amountReported}` : '',
    metadata.paymentStatusReported ? `Код состояния платежа в Flexbe: ${metadata.paymentStatusReported}` : ''].filter(Boolean).join('\n');
  string(text, 'text', MAX_TEXT);
  const snapshot = { metadata, text, occurredAt: date(data.time, 'time') };
  return { source: 'flexbe', externalId: `${event}:${id}:${hash(snapshot)}`, threadId: id,
    title: `${event === 'pay' ? 'Сообщение об оплате' : 'Заявка'} Flexbe № ${num}`.slice(0, 250),
    sender: customer || phone || email || 'Flexbe', ...snapshot, attachments: [] };
}

/** Read-only snapshot from this application's orders.json. */
export function normalizeOrder(order) {
  object(order, 'order');
  const id = string(order.id, 'id', 128, true);
  const customer = string(order.customer, 'customer', 500);
  const phone = string(order.phone, 'phone', 100);
  const comment = string(order.comment, 'comment', 10_000);
  if (!Array.isArray(order.items) || order.items.length > 5000) throw new Error('Некорректные позиции заказа');
  const items = order.items.map(item => {
    object(item, 'item');
    return { id: string(item.id, 'item.id', 256), name: string(item.name, 'item.name', 1000),
      quantity: amount(item.quantity, 'item.quantity'), sum: amount(item.sum, 'item.sum'),
      price: amount(item.cartPrice, 'item.cartPrice') };
  });
  const total = amount(order.totalSum, 'totalSum');
  const orderStatus = string(order.status, 'status', 100);
  const occurredAt = date(order.updatedAt || order.createdAt, 'createdAt');
  const snapshot = { id, customer, phone, comment, items, total, orderStatus, occurredAt };
  let text = [customer, phone, comment, ...items.map(item => `${item.name || item.id} — ${item.quantity ?? 0}; сумма ${item.sum ?? 0}`),
    total !== undefined ? `Итого: ${total} ₽` : '', orderStatus ? `Статус в магазине: ${orderStatus}` : ''].filter(Boolean).join('\n');
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 110)}\nСписок сокращён. Полный состав доступен в исходном заказе.`;
  return { source: 'zakaz-amvera', externalId: `${id}:${hash(snapshot)}`, threadId: id,
    title: `Заказ ${id}`.slice(0, 250), sender: customer || phone || 'Покупатель', text, occurredAt,
    metadata: { orderId: id, phone, total, itemCount: items.length, orderStatus, paymentVerification: 'not_verified' }, attachments: [] };
}

function clipped(value, max) { return String(value || '').replace(/\u0000/g, '').slice(0, max); }
function addresses(value) { return new Set(String(value || '').split(/[\s,;]+/).map(v => v.trim().toLowerCase()).filter(Boolean)); }
function mailSource(from, env) {
  for (const [source, key] of [['sber', 'INBOX_SBER_SENDERS'], ['tochka', 'INBOX_TOCHKA_SENDERS'], ['milku', 'INBOX_MILKU_SENDERS'], ['flexbe', 'INBOX_FLEXBE_SENDERS']]) {
    if (addresses(env[key]).has(from.toLowerCase())) return source;
  }
  return 'mail';
}

function flexbeApiUrl(value) {
  let url;
  try { url = new URL(string(value, 'INBOX_FLEXBE_API_URL', 2048, true)); } catch { throw new Error('Некорректный адрес API Flexbe'); }
  // This endpoint is the administrator-configured site, as documented by Flexbe.
  // No URL or redirect received from a webhook can select the API credential destination.
  if (!safeMediaUrl(url.href) || url.pathname !== '/mod/api/' || (url.port && url.port !== '443') ||
    /^\d+(\.\d+){3}$/.test(url.hostname) || /\.(local|localhost|internal|test|invalid)$/i.test(url.hostname)) {
    throw new Error('Некорректный адрес API Flexbe');
  }
  return url;
}

async function limitedJson(response) {
  const limit = 5 * 1024 * 1024;
  if (Number(response.headers?.get('content-length') || 0) > limit) throw new Error('Ответ API слишком большой');
  if (!response.body?.getReader) throw new Error('Пустой ответ API');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Ответ API слишком большой');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function mailEvent({ store, source, envelope, uid, account, parsed, oversize, env }) {
  const fromList = parsed?.from?.value || envelope?.from || [];
  const from = clipped(fromList.length === 1 ? fromList[0]?.address : '', 320).toLowerCase();
  const sender = clipped(fromList[0]?.name ? `${fromList[0].name} <${from}>` : from, 500) || 'Отправитель не указан';
  const kind = mailSource(from, env);
  const messageId = clipped(parsed?.messageId || envelope?.messageId, 1000);
  const identity = messageId ? hash(messageId) : hash(source || [account, uid, envelope]);
  const references = parsed?.references;
  const thread = Array.isArray(references) ? references[0] : references;
  const threadId = `${account}:${hash(thread || parsed?.inReplyTo || messageId || identity)}`;
  const attachments = [];
  const omissions = [];
  let savedBytes = 0;
  for (const attachment of parsed?.attachments || []) {
    if (!Buffer.isBuffer(attachment.content) || attachment.size > MAX_ATTACHMENT || savedBytes + attachment.size > MAX_MAIL || attachments.length >= 50) {
      omissions.push(`${filename(attachment.filename)}: превышен лимит сохранения вложений`);
      continue;
    }
    attachments.push(await store.saveAttachment(attachment.content, { name: filename(attachment.filename), contentType: clipped(attachment.contentType, 200) || 'application/octet-stream' }));
    savedBytes += attachment.content.length;
  }
  let text = oversize ? 'Письмо превышает 20 МБ. Текст и вложения не загружены; откройте оригинал в почте.' : String(parsed?.text || '').trim();
  if (!text && parsed?.html) text = 'Письмо содержит только HTML. Текст не удалось извлечь; откройте оригинал в почте.';
  if (!text) text = 'Письмо без текста.';
  if (text.length > MAX_TEXT - 500) { text = `${text.slice(0, MAX_TEXT - 600)}\nТекст сокращён; полный текст доступен в почте.`; omissions.push('Длинный текст сокращён'); }
  if (omissions.length) text += `\n\nНе сохранено полностью:\n${omissions.slice(0, 50).join('\n')}\nОткройте оригинал в почте.`;
  if (kind === 'sber' || kind === 'tochka') text = `Уведомление из письма. Операция не подтверждена и требует проверки в банке.\n\n${text}`;
  const metadata = { from, messageId, mailUid: uid, via: 'mail', ...(omissions.length ? { omissions: omissions.slice(0, 50) } : {}),
    ...(oversize ? { bodyOmitted: true, omissionReason: 'message_size_limit' } : {}),
    ...(['sber', 'tochka'].includes(kind) ? { paymentVerification: 'not_verified', bankReportedByEmail: true } : {}) };
  const receivedAt = parsed?.date || envelope?.date;
  return { source: kind, externalId: `${account}:${identity}`, threadId,
    title: clipped(parsed?.subject || envelope?.subject || 'Письмо без темы', 250), sender, text,
    ...(receivedAt && Number.isFinite(new Date(receivedAt).getTime()) ? { occurredAt: new Date(receivedAt).toISOString() } : {}), attachments, metadata };
}

/** Dependency/interval options are test seams; provider credentials remain server-only. */
export function startCollectors({ store, env = process.env, readOrders, createImapClient = options => new ImapFlow(options), pollIntervalMs = POLL_MS,
  fetchImpl = globalThis.fetch, flexbePollIntervalMs = FLEXBE_POLL_MS, flexbePageDelayMs = 750 }) {
  let stopped = false;
  let imap;
  const stopController = new AbortController();
  const timers = new Set();
  const pending = new Set();
  const interval = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : POLL_MS;
  const connection = async (id, status, message, successful = false) => {
    await store.setConnection(id, { status, message, ...(successful ? { lastSuccess: new Date().toISOString() } : {}) });
  };
  function loop(job, id, errorMessage, delay = interval) {
    const run = async () => {
      if (stopped) return;
      const current = (async () => {
        try { await job(); }
        catch { try { await connection(id, 'error', errorMessage); } catch { /* storage failure must not crash the web process */ } }
      })();
      pending.add(current);
      await current;
      pending.delete(current);
      if (!stopped) {
        const timer = setTimeout(() => { timers.delete(timer); void run(); }, delay);
        timer.unref?.();
        timers.add(timer);
      }
    };
    void run();
  }

  // Page pacing is abortable, so shutdown never waits for a pending rate-limit delay.
  const pause = milliseconds => new Promise(resolve => {
    if (stopped) { resolve(); return; }
    const finish = () => { clearTimeout(timer); stopController.signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    stopController.signal.addEventListener('abort', finish, { once: true });
  });

  // Optional read-only reconciliation complements callbacks (which have no documented retry guarantee).
  // Filters are by *creation* date, not update date. Existing leads in the seven-day overlap are revisited.
  if (env.INBOX_FLEXBE_API_URL || env.INBOX_FLEXBE_API_KEY) loop(async () => {
    if (!env.INBOX_FLEXBE_API_URL || !env.INBOX_FLEXBE_API_KEY) {
      await connection('flexbe', 'error', 'Для сверки Flexbe нужны адрес API сайта и ключ. Уведомления могут поступать отдельно.');
      return;
    }
    const url = flexbeApiUrl(env.INBOX_FLEXBE_API_URL);
    const apiKey = string(env.INBOX_FLEXBE_API_KEY, 'INBOX_FLEXBE_API_KEY', 1024, true);
    const checkpointKey = `flexbe:${hash(url.origin).slice(0, 24)}`;
    let checkpoint = store.getCheckpoint(checkpointKey);
    if (!checkpoint) {
      const since = env.INBOX_FLEXBE_SINCE ? new Date(env.INBOX_FLEXBE_SINCE) : new Date(Date.now() - FLEXBE_OVERLAP_SECONDS * 1000);
      if (!Number.isFinite(since.getTime())) throw new Error('Некорректная начальная дата Flexbe');
      checkpoint = { since: Math.floor(since.getTime() / 1000), cursor: 0 };
      await store.setCheckpoint(checkpointKey, checkpoint);
    }
    if (!Number.isSafeInteger(checkpoint.since) || !Number.isSafeInteger(checkpoint.cursor)) throw new Error('Некорректная контрольная точка Flexbe');
    const dateTo = Math.floor(Date.now() / 1000);
    const dateFrom = Math.max(checkpoint.since, checkpoint.cursor - FLEXBE_OVERLAP_SECONDS);
    if (dateFrom > dateTo) throw new Error('Начальная дата Flexbe ещё не наступила');
    let complete = false;
    for (let page = 0; page < 100; page += 1) {
      if (stopped) return;
      if (page) await pause(flexbePageDelayMs);
      if (stopped) return;
      const form = new URLSearchParams({ api_key: apiKey, method: 'getLeads', date_from: String(dateFrom), date_to: String(dateTo),
        start: String(page * FLEXBE_PAGE_SIZE), count: String(FLEXBE_PAGE_SIZE) });
      const response = await fetchImpl(url.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form, redirect: 'error', signal: AbortSignal.any([stopController.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== url.origin)) throw new Error('Ошибка API Flexbe');
      const payload = object(await limitedJson(response), 'response');
      if (payload.error || payload.status === 0 || payload.status === '0') throw new Error('API Flexbe отклонил запрос');
      const data = object(payload.data, 'response.data');
      const leadsValue = data.leads;
      if (!leadsValue || typeof leadsValue !== 'object') throw new Error('Некорректный список заявок Flexbe');
      const leads = Array.isArray(leadsValue) ? leadsValue : Object.values(leadsValue);
      if (leads.length > FLEXBE_PAGE_SIZE) throw new Error('Нарушен размер страницы API Flexbe');
      const events = leads.map(lead => normalizeFlexbe({ event: 'lead', data: lead }));
      events.sort((a, b) => (a.occurredAt || '').localeCompare(b.occurredAt || ''));
      for (const event of events) {
        if (stopped) return;
        await store.ingest(event);
      }
      if (leads.length < FLEXBE_PAGE_SIZE) { complete = true; break; }
    }
    if (!complete) throw new Error('Слишком много страниц Flexbe');
    // No cursor progress on failed page, failed save, shutdown, malformed response or incomplete pagination.
    await store.setCheckpoint(checkpointKey, { ...checkpoint, cursor: dateTo });
    await connection('flexbe', 'ok', `Сверка заявок каждые 60 секунд с ${new Date(checkpoint.since * 1000).toISOString().slice(0, 10)}. Повторно проверяются заявки, созданные за последние 7 дней; изменения более старых заявок приходят только через уведомления.`, true);
  }, 'flexbe', 'Сверка Flexbe не выполнена. Последняя контрольная точка сохранена; проверьте HTTPS-адрес API сайта и ключ. Повторная попытка будет выполнена автоматически.', flexbePollIntervalMs);

  loop(async () => {
    if (typeof readOrders !== 'function') { await connection('zakaz-amvera', 'not_configured', 'Источник заказов не настроен.'); return; }
    const orders = await readOrders();
    if (!Array.isArray(orders)) throw new Error('Некорректный список заказов');
    const events = [];
    let invalidCount = 0;
    for (const order of orders) {
      try { events.push(normalizeOrder(order)); } catch { invalidCount += 1; }
    }
    events.sort((a, b) => (a.occurredAt || '').localeCompare(b.occurredAt || ''));
    for (const event of events) {
      if (stopped) return;
      await store.ingest(event);
    }
    if (invalidCount) {
      await connection('zakaz-amvera', 'error', `Заказы с некорректными данными (${invalidCount}) не загружены. Остальные заказы обработаны; проверьте исходный список.`);
      return;
    }
    await connection('zakaz-amvera', 'ok', 'Чтение заказов каждые 30 секунд. Изменения в магазин не отправляются.', true);
  }, 'zakaz-amvera', 'Не удалось прочитать заказы. Повторная попытка будет выполнена автоматически.');

  loop(async () => {
    if (!env.INBOX_IMAP_USER || !env.INBOX_IMAP_PASSWORD) {
      await connection('mail', 'not_configured', 'Укажите почтовый ящик и пароль приложения в настройках сервера.');
      return;
    }
    const host = String(env.INBOX_IMAP_HOST || 'imap.yandex.ru').trim();
    const folder = String(env.INBOX_IMAP_FOLDER || 'INBOX');
    if (!host || /[/:\s]/.test(host) || host.length > 253 || folder.length > 500) throw new Error('Некорректные настройки почты');
    const account = hash([host, String(env.INBOX_IMAP_USER).toLowerCase(), folder]).slice(0, 24);
    const checkpointKey = `imap:${account}`;
    let checkpoint = store.getCheckpoint(checkpointKey);
    if (!checkpoint) {
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const since = env.INBOX_MAIL_SINCE ? new Date(env.INBOX_MAIL_SINCE) : today;
      if (!Number.isFinite(since.getTime())) throw new Error('Некорректная начальная дата');
      checkpoint = { since: since.toISOString(), uidValidity: '', lastUid: 0 };
      await store.setCheckpoint(checkpointKey, checkpoint);
    }
    if (!Number.isFinite(new Date(checkpoint.since).getTime())) throw new Error('Некорректная сохранённая дата');
    const client = createImapClient({ host, port: 993, secure: true,
      auth: { user: env.INBOX_IMAP_USER, pass: env.INBOX_IMAP_PASSWORD },
      tls: { rejectUnauthorized: true }, logger: false, disableAutoIdle: true,
      connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 30_000 });
    imap = client;
    client.on?.('error', () => {}); // Errors are surfaced as a generic connection status, never credential-bearing logs.
    try {
      await client.connect();
      await client.mailboxOpen(folder, { readOnly: true });
      const validity = String(client.mailbox.uidValidity);
      if (checkpoint.uidValidity !== validity) {
        checkpoint = { ...checkpoint, uidValidity: validity, lastUid: 0 };
        await store.setCheckpoint(checkpointKey, checkpoint);
      }
      const query = { since: new Date(checkpoint.since), ...(checkpoint.lastUid ? { uid: `${checkpoint.lastUid + 1}:*` } : {}) };
      const found = await client.search(query, { uid: true });
      const uids = (Array.isArray(found) ? found : []).filter(uid => Number.isSafeInteger(uid) && uid > checkpoint.lastUid).sort((a, b) => a - b);
      for (const uid of uids) {
        if (stopped) return;
        const header = await client.fetchOne(uid, { envelope: true, size: true, internalDate: true }, { uid: true });
        if (!header) continue; // Expunged concurrently; later UIDs remain safe to checkpoint.
        let event;
        if (header.size > MAX_MAIL) {
          event = await mailEvent({ store, envelope: header.envelope, uid, account, oversize: true, env });
        } else {
          // Partial fetch guarantees bounded memory even if a server understates RFC822.SIZE.
          const result = await client.fetchOne(uid, { source: { start: 0, maxLength: MAX_MAIL + 1 } }, { uid: true });
          if (!result) continue;
          if (!Buffer.isBuffer(result.source)) throw new Error('Не удалось прочитать письмо');
          if (result.source.length > MAX_MAIL) {
            event = await mailEvent({ store, envelope: header.envelope, uid, account, oversize: true, env });
          } else {
            const parsed = await simpleParser(result.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: MAX_MAIL });
            event = await mailEvent({ store, source: result.source, envelope: header.envelope, uid, account, parsed, env });
          }
        }
        await store.ingest(event);
        if (event.source !== 'mail') await connection(event.source, 'ok', 'Получено письмо от настроенного отправителя. Подлинность операции проверяйте в исходном сервисе.', true);
        checkpoint = { ...checkpoint, lastUid: uid };
        await store.setCheckpoint(checkpointKey, checkpoint);
      }
      await connection('mail', 'ok', `Письма проверяются каждые 30 секунд, начиная с ${checkpoint.since.slice(0, 10)}. Более ранние письма не загружаются.`, true);
    } finally {
      try { await client.logout(); } catch { client.close?.(); }
      if (imap === client) imap = undefined;
    }
  }, 'mail', 'Не удалось получить почту. Проверьте адрес, пароль приложения и доступ IMAP; повторная попытка будет выполнена автоматически.');

  return async function stop() {
    stopped = true;
    stopController.abort();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    try { imap?.close(); } catch { /* already disconnected */ }
    await Promise.allSettled([...pending]);
  };
}
