import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { log, clearLog } from '../lib/logger.js';

let ctx;
beforeEach(() => { ctx = installChromeMock(); });

test('log: appends a timestamped, serialized line', async () => {
  await log('photo_uploaded', { i: 0, id: 123 });
  const lines = ctx.store.log;
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[.*\] photo_uploaded \{"i":0,"id":123\}$/);
});

test('log: keeps at most 500 lines (ring buffer)', async () => {
  installChromeMock({ log: Array.from({ length: 499 }, (_, i) => `old${i}`) });
  await log('e1');
  await log('e2');
  const { log: out } = await chrome.storage.local.get('log');
  assert.equal(out.length, 500);            // capped
  assert.match(out[out.length - 1], /e2/);  // newest kept
  assert.equal(out[0], 'old1');             // oldest ('old0') dropped
});

test('clearLog: empties the log', async () => {
  await log('x');
  await clearLog();
  const { log: out } = await chrome.storage.local.get('log');
  assert.deepEqual(out, []);
});
