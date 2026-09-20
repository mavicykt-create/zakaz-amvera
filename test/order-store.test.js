import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOrderAppender } from '../src/order-store.js';

async function storage(t, initial = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'order-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'orders.json');
  await fs.writeFile(file, JSON.stringify(initial));
  return { directory, file };
}

test('simultaneous order appends preserve every order and existing fields', async t => {
  const prior = { id: 'ORD-existing', customer: 'Existing customer', items: [], totalSum: 123 };
  const { file } = await storage(t, [prior]);
  const append = createOrderAppender(file);
  const incoming = Array.from({ length: 80 }, (_, index) => ({ id: `ORD-test-${index}`, customer: `Customer ${index}`, items: [{ id: 'item', quantity: 1 }], totalSum: index }));
  let reading = true;
  const reader = (async () => {
    while (reading) {
      const snapshot = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.ok(Array.isArray(snapshot));
      await new Promise(resolve => setImmediate(resolve));
    }
  })();
  try { await Promise.all(incoming.map(order => append(order))); }
  finally { reading = false; await reader; }
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved, [...incoming].reverse().concat(prior));
  assert.equal(new Set(saved.map(order => order.id)).size, 81);
});

test('failed atomic replacement preserves prior data, cleans temp files and permits retry', async t => {
  const prior = { id: 'ORD-existing', items: [], totalSum: 1 };
  const { directory, file } = await storage(t, [prior]);
  let failNext = true;
  const append = createOrderAppender(file, { filesystem: { ...fs, rename: async (...args) => {
    if (failNext) { failNext = false; throw Object.assign(new Error('Simulated write failure'), { code: 'ENOSPC' }); }
    return fs.rename(...args);
  } } });
  const next = { id: 'ORD-next', items: [], totalSum: 2 };
  await assert.rejects(append(next), /Simulated/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [prior]);
  assert.deepEqual(await fs.readdir(directory), ['orders.json']);
  await append(next);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [next, prior]);
});

test('successful order append syncs contents before rename and parent directory before resolving', async t => {
  const { file } = await storage(t);
  const calls = [];
  const append = createOrderAppender(file, { filesystem: { ...fs,
    open: async (target, ...args) => {
      const handle = await fs.open(target, ...args);
      return { writeFile: (...values) => handle.writeFile(...values), close: () => handle.close(), sync: async () => {
        calls.push(target.endsWith('.tmp') ? 'sync-file' : 'sync-directory');
        await handle.sync();
      } };
    },
    rename: async (...args) => { calls.push('rename'); await fs.rename(...args); }
  } });
  await append({ id: 'ORD-test', items: [] });
  calls.push('resolved');
  assert.deepEqual(calls, ['sync-file', 'rename', 'sync-directory', 'resolved']);
});
