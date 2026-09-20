import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export function equal(a, b) {
  return crypto.timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 512) throw new Error('Пароль: от 14 до 512 символов');
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await scrypt(password, salt, 64)).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 512 || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded)) return false;
  const [, salt, hash] = encoded.split('$');
  return equal((await scrypt(password, salt, 64)).toString('hex'), hash);
}
export function base32Encode(buffer) {
  let bits = 0, value = 0, result = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function base32Decode(secret) {
  if (!/^[A-Z2-7]{32,128}$/.test(secret)) throw new Error('Неверный секрет TOTP');
  let bits = 0, value = 0;
  const out = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totp(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
export function verifyTotp(secret, code, lastCounter = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const current = Math.floor(now / 30000);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter > lastCounter && equal(totp(secret, counter), code)) return counter;
  }
  return null;
}
export function encrypt(buffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([Buffer.from('INB1'), iv, cipher.getAuthTag(), ciphertext]);
}
export function decrypt(buffer, key) {
  if (buffer.length < 32 || buffer.subarray(0, 4).toString() !== 'INB1') throw new Error('Неверный формат хранилища');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(4, 16));
  decipher.setAuthTag(buffer.subarray(16, 32));
  return Buffer.concat([decipher.update(buffer.subarray(32)), decipher.final()]);
}
export function inboxConfig(env) {
  if (env.INBOX_ENABLED !== 'true') return null;
  const origin = new URL(env.INBOX_ORIGIN || '');
  const development = env.NODE_ENV === 'development' && ['localhost', '127.0.0.1'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(development && origin.protocol === 'http:')) throw new Error('Для доски требуется HTTPS');
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('INBOX_ORIGIN должен содержать только origin');
  if (!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(env.INBOX_PASSWORD_HASH || '')) throw new Error('Настройте INBOX_PASSWORD_HASH');
  base32Decode(env.INBOX_TOTP_SECRET || '');
  if (!/^[a-f0-9]{64}$/.test(env.INBOX_ENCRYPTION_KEY || '')) throw new Error('Настройте INBOX_ENCRYPTION_KEY');
  for (const name of ['INBOX_WHATSAPP_WEBHOOK_TOKEN', 'INBOX_MAX_WEBHOOK_TOKEN', 'INBOX_FLEXBE_WEBHOOK_TOKEN']) {
    if (env[name] && !/^[a-zA-Z0-9_-]{40,128}$/.test(env[name])) throw new Error(`Некорректная настройка ${name}`);
  }
  return { origin: origin.origin, secure: !development, passwordHash: env.INBOX_PASSWORD_HASH, totpSecret: env.INBOX_TOTP_SECRET, encryptionKey: Buffer.from(env.INBOX_ENCRYPTION_KEY, 'hex') };
}
