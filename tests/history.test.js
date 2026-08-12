import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { getHistory, addEntry, clearHistory, getCounts, countWindows } from '../lib/history.js';

const HOUR = 3600e3;

beforeEach(() => installChromeMock());

test('addEntry: newest first, stamps ts', async () => {
  await addEntry({ oldId: '1', newId: '2', title: 'A' });
  await addEntry({ oldId: '3', newId: '4', title: 'B' });
  const h = await getHistory();
  assert.equal(h.length, 2);
  assert.equal(h[0].title, 'B');
  assert.ok(h[0].ts > 0);
});

test('addEntry: caps at 100 entries', async () => {
  for (let i = 0; i < 105; i++) await addEntry({ oldId: String(i) });
  const h = await getHistory();
  assert.equal(h.length, 100);
  // newest (104) retained, oldest (0..4) dropped
  assert.equal(h[0].oldId, '104');
});

test('clearHistory: empties the list', async () => {
  await addEntry({ oldId: '1' });
  await clearHistory();
  assert.deepEqual(await getHistory(), []);
});

test('getCounts: windows last hour vs last 24h', async () => {
  const now = Date.now();
  installChromeMock({
    relistHistory: [
      { ts: now - 5 * 60e3 },        // 5 min ago
      { ts: now - 30 * 60e3 },       // 30 min ago
      { ts: now - 5 * HOUR },        // 5 h ago
      { ts: now - 30 * HOUR }        // 30 h ago (outside 24h)
    ]
  });
  const c = await getCounts();
  assert.equal(c.lastHour, 2);
  assert.equal(c.last24h, 3);
  assert.equal(c.total, 4);
});

test('getCounts: empty history → zeros', async () => {
  assert.deepEqual(await getCounts(), { lastHour: 0, last24h: 0, total: 0 });
});

// ---- countWindows: the same tally, pure, for callers that already hold the entries ----

test('countWindows: tallies both rolling windows without touching storage', () => {
  const now = Date.now();
  const entries = [
    { ts: now - 60e3 },            // 1 min  → both windows
    { ts: now - 2 * 3600e3 },      // 2 h    → 24h only
    { ts: now - 48 * 3600e3 }      // 2 days → neither
  ];
  assert.deepEqual(countWindows(entries), { lastHour: 1, last24h: 2, total: 3 });
});

test('countWindows: an entry with no timestamp counts as ancient', () => {
  assert.deepEqual(countWindows([{}]), { lastHour: 0, last24h: 0, total: 1 });
});

test('countWindows: copes with no argument', () => {
  assert.deepEqual(countWindows(), { lastHour: 0, last24h: 0, total: 0 });
});

test('countWindows agrees with getCounts on the same entries', async () => {
  await addEntry({ oldId: '1', newId: '2' });
  assert.deepEqual(countWindows(await getHistory()), await getCounts());
});
