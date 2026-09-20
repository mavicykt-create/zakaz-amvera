import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inboxConfig, equal, digest, verifyPassword, verifyTotp } from './security.js';
import { InboxStore, SOURCES } from './store.js';
import { normalizeGreen, normalizeFlexbe, startCollectors } from './connectors.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cookieName = 'planet_inbox_session';
const sessionDuration = 8 * 60 * 60 * 1000;

export async function createInbox({ env = process.env, dataDir, readOrders, collectors = true }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    next();
  });
  router.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  router.use('/assets', express.static(publicDir, { index: false, dotfiles: 'deny' }));
  let config, store;
  try {
    config = inboxConfig(env);
    if (config) store = await new InboxStore(path.join(dataDir, 'inbox'), config.encryptionKey).open();
  } catch {
    console.error('Inbox initialization failed. Check private configuration and encrypted storage.');
  }
  if (!store) {
    router.use((req, res) => res.status(503).json({ error: 'Доска ещё не настроена. Администратор должен завершить настройку защищённого доступа.' }));
    return { router, stop: async () => {}, store: null };
  }
  router.use(express.json({ limit: '2mb' }));
  router.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 1000, depth: 8 }));
  const sessions = new Map(), streams = new Set();
  let passwordChecks = 0;
  function getSession(req) {
    const item = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`));
    const raw = item?.slice(cookieName.length + 1);
    if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
    const id = digest(raw), session = sessions.get(id);
    if (!session || session.expires <= Date.now()) { sessions.delete(id); return null; }
    return { ...session, id };
  }
  function requireSession(req, res, next) {
    req.inboxSession = getSession(req);
    if (!req.inboxSession) return res.status(401).json({ error: 'Войдите в доску' });
    next();
  }
  function requireOrigin(req, res, next) {
    if (req.headers.origin !== config.origin) return res.status(403).json({ error: 'Запрос отклонён' });
    next();
  }
  function csrf(req, res, next) {
    if (!equal(req.headers['x-csrf-token'] || '', req.inboxSession.csrf)) return res.status(403).json({ error: 'Обновите страницу и повторите действие' });
    requireOrigin(req, res, next);
  }
  const sessionBody = session => ({ user: 'Евгений', csrfToken: session.csrf, timeZone: 'Asia/Yakutsk' });
  router.post('/api/login', requireOrigin, wrap(async (req, res) => {
    const now = Date.now();
    // A global limit suits this owner-only board and does not trust spoofable forwarded IP headers.
    let attempts = store.getCheckpoint('loginAttempts') || [];
    attempts = attempts.filter(x => x > now - 15 * 60 * 1000);
    if (attempts.length >= 10 || passwordChecks >= 2) { res.set('Retry-After', '900'); return res.status(429).json({ error: 'Слишком много попыток. Повторите через 15 минут.' }); }
    passwordChecks += 1;
    try {
      await store.mutate(state => {
        const entries = (state.checkpoints.loginAttempts || []).filter(x => x > now - 15 * 60 * 1000);
        if (entries.length >= 10) throw Object.assign(new Error('Слишком много попыток'), { status: 429 });
        entries.push(now); state.checkpoints.loginAttempts = entries;
      }, false);
      const { password, code } = req.body || {};
      const validPassword = await verifyPassword(password, config.passwordHash);
      const counter = verifyTotp(config.totpSecret, code, store.getCheckpoint('lastTotpCounter'));
      if (!validPassword || counter === null || !(await store.acceptTotp(counter))) return res.status(401).json({ error: 'Неверный пароль или код. Используйте новый код из приложения.' });
      const raw = crypto.randomBytes(32).toString('hex');
      const session = { csrf: crypto.randomBytes(32).toString('hex'), expires: now + sessionDuration };
      for (const [id, entry] of sessions) if (entry.expires <= now) sessions.delete(id);
      if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
      sessions.set(digest(raw), session);
      res.cookie(cookieName, raw, { httpOnly: true, secure: config.secure, sameSite: 'strict', path: '/inbox', maxAge: sessionDuration });
      res.json(sessionBody(session));
    } finally { passwordChecks -= 1; }
  }));

  for (const source of ['whatsapp', 'max']) {
    const token = env[`INBOX_${source.toUpperCase()}_WEBHOOK_TOKEN`];
    const instanceId = env[`INBOX_${source.toUpperCase()}_INSTANCE_ID`];
    await store.setConnection(source, { status: token && instanceId ? 'waiting' : 'not_configured', message: token && instanceId ? 'Ожидается первое уведомление' : 'Подключение не настроено' });
    router.post(`/hooks/${source}`, wrap(async (req, res) => {
      if (!token || !instanceId) return res.sendStatus(404);
      if (!equal(req.headers.authorization || '', `Bearer ${token}`)) return res.sendStatus(401);
      if (String(req.body?.instanceData?.idInstance || '') !== String(instanceId)) return res.status(400).json({ error: 'Неизвестный аккаунт' });
      let event;
      try { event = normalizeGreen(req.body, source); } catch { return res.status(400).json({ error: 'Некорректное уведомление' }); }
      if (event) await store.ingest(event);
      await store.setConnection(source, { status: 'ok', lastSuccess: new Date().toISOString(), message: 'Уведомления поступают' });
      res.sendStatus(200);
    }));
  }
  const flexbeToken = env.INBOX_FLEXBE_WEBHOOK_TOKEN;
  await store.setConnection('flexbe', { status: flexbeToken ? 'waiting' : 'not_configured', message: flexbeToken ? 'Ожидается первое уведомление' : 'Можно подключить уведомления или письма' });
  await store.setConnection('milku', { status: env.INBOX_MILKU_SENDERS ? 'waiting' : 'not_configured', message: 'Получение заказов из писем; адреса отправителей задаются при подключении' });
  for (const source of ['sber', 'tochka']) {
    const configured = env[`INBOX_${source.toUpperCase()}_SENDERS`] && env.INBOX_IMAP_USER && env.INBOX_IMAP_PASSWORD;
    await store.setConnection(source, { status: configured ? 'waiting' : 'not_configured', message: configured ? 'Ожидается письмо от настроенного отправителя' : 'Нужно подключить почту и указать адрес отправителя банковских писем' });
  }
  // Flexbe does not document signed callbacks/custom Authorization. Use a random callback secret;
  // treat its contents as reported events only. Never mark an order as paid from this callback.
  router.post('/hooks/flexbe/:token', wrap(async (req, res) => {
    if (!flexbeToken) return res.sendStatus(404);
    if (!equal(req.params.token, flexbeToken)) return res.sendStatus(401);
    let event;
    try { event = normalizeFlexbe(req.body); } catch { return res.status(400).json({ error: 'Некорректное уведомление' }); }
    if (event) await store.ingest(event);
    await store.setConnection('flexbe', { status: 'ok', lastSuccess: new Date().toISOString(), message: 'Уведомления поступают' });
    res.sendStatus(200);
  }));

  router.use('/api', requireSession);
  router.get('/api/session', (req, res) => res.json(sessionBody(req.inboxSession)));
  router.post('/api/logout', csrf, (req, res) => {
    sessions.delete(req.inboxSession.id);
    for (const stream of streams) if (stream.id === req.inboxSession.id) stream.res.end();
    res.clearCookie(cookieName, { path: '/inbox', httpOnly: true, secure: config.secure, sameSite: 'strict' });
    res.json({ ok: true });
  });
  router.get('/api/board', (req, res) => res.json(store.board()));
  router.get('/api/cards/:id', (req, res) => {
    const detail = store.detail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Карточка не найдена' });
    res.json(detail);
  });
  router.post('/api/cards', csrf, wrap(async (req, res) => {
    const { title, text = '', dueAt } = req.body || {};
    if (typeof title !== 'string' || !title.trim() || title.length > 250 || typeof text !== 'string' || text.length > 10000) return res.status(400).json({ error: 'Укажите название до 250 символов и описание до 10 000 символов' });
    if (dueAt !== undefined && dueAt !== null && (typeof dueAt !== 'string' || Number.isNaN(new Date(dueAt).getTime()))) return res.status(400).json({ error: 'Неверный срок' });
    const result = await store.ingest({ source: 'manual', externalId: crypto.randomUUID(), title: title.trim(), text, sender: 'Евгений' });
    if (dueAt) await store.update(result.cardId, { dueAt });
    res.status(201).json({ ...result, card: store.detail(result.cardId).card });
  }));
  router.patch('/api/cards/:id', csrf, wrap(async (req, res) => {
    const body = req.body || {};
    if (!['status', 'dueAt', 'unread'].some(key => Object.hasOwn(body, key))) return res.status(400).json({ error: 'Нет изменений' });
    res.json({ card: await store.update(req.params.id, body) });
  }));
  router.post('/api/cards/:id/notes', csrf, wrap(async (req, res) => res.status(201).json({ note: await store.addNote(req.params.id, req.body?.text) })));
  router.get('/api/attachments/:id', wrap(async (req, res) => {
    const attachment = await store.readAttachment(req.params.id);
    if (!attachment) return res.sendStatus(404);
    const name = attachment.meta.name.replace(/[\r\n\x00-\x1f]/g, '').slice(0, 180) || 'attachment';
    res.set('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.type('application/octet-stream').send(attachment.data);
  }));
  router.get('/api/stream', (req, res) => {
    const entry = { id: req.inboxSession.id, res };
    if (streams.size >= 20) return res.status(429).json({ error: 'Слишком много открытых окон' });
    res.set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`event: ready\ndata: ${JSON.stringify({ version: store.state.version })}\n\n`);
    streams.add(entry);
    const update = value => {
      if (!sessions.has(entry.id) || sessions.get(entry.id).expires <= Date.now()) return res.end();
      res.write(`event: change\ndata: ${JSON.stringify(value)}\n\n`);
    };
    store.on('change', update);
    const heartbeat = setInterval(() => { if (!getSession(req)) res.end(); else res.write(': heartbeat\n\n'); }, 15000);
    heartbeat.unref();
    req.on('close', () => { clearInterval(heartbeat); store.off('change', update); streams.delete(entry); });
  });
  router.use((req, res) => res.status(404).json({ error: 'Не найдено' }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error('Inbox operation failed; event not acknowledged.');
    res.status(status).json({ error: status === 500 ? 'Не удалось сохранить данные. Повторите действие.' : status === 413 ? 'Слишком большой запрос' : error.message || 'Некорректный запрос' });
  });
  const stopCollectors = collectors ? await startCollectors({ store, env, readOrders }) : async () => {};
  return { router, store, stop: async () => { for (const stream of streams) stream.res.end(); await stopCollectors(); await store.queue; } };
}
