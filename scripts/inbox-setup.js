import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { hashPassword, base32Encode } from '../src/inbox/security.js';

if (!process.stdin.isTTY) throw new Error('Запускайте настройку в личном терминале');
const target = process.argv[2] || '.inbox-secrets.env';
let hidden = false;
const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
const input = readline.createInterface({ input: process.stdin, output, terminal: true });
try {
  const origin = new URL((await input.question('Адрес приложения Amvera (https://...): ')).trim());
  if (origin.protocol !== 'https:') throw new Error('Нужен HTTPS адрес');
  process.stdout.write('Новый пароль доски (не меньше 14 символов): '); hidden = true;
  const password = await input.question(''); hidden = false; process.stdout.write('\n');
  process.stdout.write('Повторите пароль: '); hidden = true;
  const repeated = await input.question(''); hidden = false; process.stdout.write('\n');
  if (password !== repeated) throw new Error('Пароли не совпадают');
  const secret = base32Encode(crypto.randomBytes(20));
  const values = {
    INBOX_ENABLED: 'true', INBOX_ORIGIN: origin.origin,
    INBOX_PASSWORD_HASH: await hashPassword(password), INBOX_TOTP_SECRET: secret,
    INBOX_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    INBOX_WHATSAPP_WEBHOOK_TOKEN: crypto.randomBytes(32).toString('hex'),
    INBOX_MAX_WEBHOOK_TOKEN: crypto.randomBytes(32).toString('hex'),
    INBOX_FLEXBE_WEBHOOK_TOKEN: crypto.randomBytes(32).toString('hex'),
    INBOX_ORDERS_READ_TOKEN: crypto.randomBytes(32).toString('hex')
  };
  await fs.writeFile(target, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Настройки сохранены: ${target}. Перенесите значения в секреты Amvera, затем уберите файл в защищённое хранилище.`);
  console.log('В приложении-аутентификаторе добавьте вручную аккаунт «Пульт Сладкой планеты», ключ:');
  console.log(secret);
  console.log('Параметры: TOTP, 6 цифр, период 30 секунд, SHA-1. Сохраните резервную копию ключа отдельно от сервера.');
} finally { input.close(); }
