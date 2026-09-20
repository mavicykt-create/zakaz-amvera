import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { encrypt, decrypt, digest } from './security.js';

export const SOURCES = {
  mail: 'Почта', sber: 'Сбербанк · письмо', tochka: 'Точка · письмо', whatsapp: 'WhatsApp',
  max: 'MAX', milku: 'milku.ru', flexbe: 'Flexbe', 'zakaz-amvera': 'Онлайн-заказы', manual: 'Мои задачи'
};
export const STATUSES = ['new', 'working', 'waiting', 'done'];
const short = (value, limit = 2000) => String(value ?? '').slice(0, limit);
function timestamp(value, fallback = new Date().toISOString()) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toISOString() : fallback;
}
export class InboxStore extends EventEmitter {
  constructor(directory, key) {
    super();
    this.directory = directory; this.key = key; this.file = path.join(directory, 'state.enc');
    this.queue = Promise.resolve();
    this.state = { version: 0, cards: {}, events: {}, dedup: {}, threads: {}, notes: {}, connections: {}, checkpoints: {}, attachments: {}, audit: [] };
  }
  async open() {
    await fs.mkdir(path.join(this.directory, 'files'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.directory, 'backups'), { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(decrypt(await fs.readFile(this.file), this.key).toString()); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Хранилище доски недоступно: проверьте ключ и резервную копию', { cause: error }); }
    return this;
  }
  async persist(next) {
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(encrypt(Buffer.from(JSON.stringify(next)), this.key)); await handle.sync(); }
    finally { await handle.close(); }
    try {
      const day = new Date().toISOString().slice(0, 10);
      try { await fs.copyFile(this.file, path.join(this.directory, 'backups', `${day}.enc`), 1); }
      catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
      await fs.rename(tmp, this.file);
      const directory = await fs.open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { await fs.unlink(tmp).catch(() => {}); throw error; }
  }
  async mutate(fn, notify = true) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const value = await fn(next);
      if (value?.unchanged) return value.result;
      next.version += 1;
      await this.persist(next);
      this.state = next;
      if (notify) this.emit('change', { version: next.version });
      return value;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async ingest(input) {
    if (!input || !SOURCES[input.source] || !input.externalId || String(input.externalId).length > 1000) throw new Error('Некорректное событие');
    const source = input.source;
    const unique = digest(`${source}\0${input.externalId}`);
    const thread = digest(`${source}\0${input.threadId || input.externalId}`);
    return this.mutate(state => {
      if (state.dedup[unique]) return { unchanged: true, result: { duplicate: true, cardId: state.dedup[unique] } };
      const now = new Date().toISOString();
      let card = state.cards[state.threads[thread]];
      if (!card) {
        card = { id: crypto.randomUUID(), source, title: short(input.title || SOURCES[source], 250), sender: short(input.sender, 250), status: 'new', dueAt: null, createdAt: now, updatedAt: now, preview: '', eventCount: 0, unread: true };
        state.cards[card.id] = card; state.threads[thread] = card.id;
      }
      const event = { id: crypto.randomUUID(), cardId: card.id, source, sender: short(input.sender, 250), text: short(input.text, 100000), occurredAt: timestamp(input.occurredAt), receivedAt: now, attachments: [] };
      if (input.metadata && JSON.stringify(input.metadata).length <= 64000) event.metadata = structuredClone(input.metadata);
      for (const item of (input.attachments || []).slice(0, 50)) {
        if (item.id && state.attachments[item.id]) event.attachments.push(structuredClone(state.attachments[item.id]));
        else if (item.url) {
          try { const url = new URL(item.url); if (url.protocol === 'https:' && !url.username && !url.password) event.attachments.push({ name: short(item.name || 'Вложение', 250), size: Math.max(0, Number(item.size) || 0), url: url.href }); } catch {}
        } else event.attachments.push({ name: short(item.name || 'Вложение не сохранено', 250), size: Math.max(0, Number(item.size) || 0) });
      }
      state.events[event.id] = event;
      state.dedup[unique] = card.id;
      card.preview = event.text.slice(0, 250); card.updatedAt = now; card.eventCount += 1; card.unread = true;
      return { duplicate: false, cardId: card.id };
    });
  }
  board() {
    return structuredClone({ cards: Object.values(this.state.cards).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), connections: Object.values(this.state.connections), version: this.state.version, now: new Date().toISOString(), timeZone: 'Asia/Yakutsk' });
  }
  detail(id) {
    if (!this.state.cards[id]) return null;
    return structuredClone({ card: this.state.cards[id], events: Object.values(this.state.events).filter(x => x.cardId === id).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)), notes: Object.values(this.state.notes).filter(x => x.cardId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
  }
  async update(id, patch) {
    return this.mutate(state => {
      const card = state.cards[id];
      if (!card) throw Object.assign(new Error('Карточка не найдена'), { status: 404 });
      if (patch.status !== undefined) { if (!STATUSES.includes(patch.status)) throw Object.assign(new Error('Неверный статус'), { status: 400 }); card.status = patch.status; }
      if (patch.dueAt !== undefined) { if (patch.dueAt !== null && (typeof patch.dueAt !== 'string' || !timestamp(patch.dueAt, null))) throw Object.assign(new Error('Неверный срок'), { status: 400 }); card.dueAt = patch.dueAt === null ? null : timestamp(patch.dueAt); }
      if (patch.unread !== undefined) card.unread = Boolean(patch.unread);
      card.updatedAt = new Date().toISOString();
      state.audit.push({ at: card.updatedAt, action: 'card.update', cardId: id, status: card.status, dueAt: card.dueAt });
      return structuredClone(card);
    });
  }
  async addNote(id, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw Object.assign(new Error('Заметка: от 1 до 10 000 символов'), { status: 400 });
    return this.mutate(state => {
      if (!state.cards[id]) throw Object.assign(new Error('Карточка не найдена'), { status: 404 });
      const note = { id: crypto.randomUUID(), cardId: id, text: text.trim(), createdAt: new Date().toISOString() };
      state.notes[note.id] = note;
      state.audit.push({ at: note.createdAt, action: 'note.add', cardId: id });
      return note;
    });
  }
  async setConnection(id, patch) {
    if (!SOURCES[id]) throw new Error('Неизвестное подключение');
    return this.mutate(state => { state.connections[id] = { id, label: SOURCES[id], ...state.connections[id], ...patch }; }, false);
  }
  getCheckpoint(key) { return structuredClone(this.state.checkpoints[key]); }
  async setCheckpoint(key, value) { return this.mutate(state => { state.checkpoints[key] = structuredClone(value); }, false); }
  async acceptTotp(counter) {
    return this.mutate(state => {
      if (counter <= (state.checkpoints.lastTotpCounter ?? -1)) return { unchanged: true, result: false };
      state.checkpoints.lastTotpCounter = counter;
      state.audit.push({ at: new Date().toISOString(), action: 'auth.login' });
      return true;
    }, false);
  }
  async saveAttachment(buffer, { name, contentType }) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 20 * 1024 * 1024) throw new Error('Вложение слишком большое');
    const id = digest(buffer);
    if (this.state.attachments[id]) return structuredClone(this.state.attachments[id]);
    const meta = { id, name: short(name || 'Вложение', 250), size: buffer.length, contentType: short(contentType || 'application/octet-stream', 100) };
    const target = path.join(this.directory, 'files', `${id}.enc`);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(encrypt(buffer, this.key)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, target);
    const directory = await fs.open(path.dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    await this.mutate(state => { state.attachments[id] = meta; }, false);
    return meta;
  }
  async readAttachment(id) {
    if (!/^[a-f0-9]{64}$/.test(id) || !this.state.attachments[id]) return null;
    return { meta: structuredClone(this.state.attachments[id]), data: decrypt(await fs.readFile(path.join(this.directory, 'files', `${id}.enc`)), this.key) };
  }
}
