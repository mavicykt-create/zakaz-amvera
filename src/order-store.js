import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// One writer process owns orders.json. Queue the entire read/modify/write operation;
// readers see either the previous complete JSON snapshot or the next complete one.
export function createOrderAppender(file, { filesystem = fs } = {}) {
  let queue = Promise.resolve();
  return function appendOrder(order) {
    const snapshot = structuredClone(order);
    const operation = queue.then(async () => {
      const orders = JSON.parse(await filesystem.readFile(file, 'utf8'));
      if (!Array.isArray(orders)) throw new Error('Invalid order storage');
      orders.unshift(snapshot);
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        const handle = await filesystem.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(orders, null, 2), 'utf8');
          await handle.sync();
        } finally { await handle.close(); }
        await filesystem.rename(temporary, file);
        const directory = await filesystem.open(path.dirname(file), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        await filesystem.unlink(temporary).catch(() => {});
        throw error;
      }
    });
    queue = operation.catch(() => {});
    return operation;
  };
}
