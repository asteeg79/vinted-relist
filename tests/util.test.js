import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleep, jitter, uuidV4, arrayBufferToBase64 } from '../lib/util.js';

test('sleep: resolves after roughly the given delay', async () => {
  const t0 = Date.now();
  await sleep(30);
  assert.ok(Date.now() - t0 >= 25);
});

test('jitter: stays within [min, max)', () => {
  for (let i = 0; i < 200; i++) {
    const v = jitter(100, 200);
    assert.ok(v >= 100 && v < 200, `out of range: ${v}`);
  }
});

test('jitter: produces varied values', () => {
  const set = new Set();
  for (let i = 0; i < 50; i++) set.add(jitter(0, 1000));
  assert.ok(set.size > 40, 'jitter should not be constant');
});

test('uuidV4: matches RFC4122 v4 shape', () => {
  const re = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  for (let i = 0; i < 20; i++) assert.match(uuidV4(), re);
});

test('uuidV4: unique across calls', () => {
  const set = new Set();
  for (let i = 0; i < 1000; i++) set.add(uuidV4());
  assert.equal(set.size, 1000);
});

test('uuidV4: manual fallback when crypto.randomUUID is unavailable', () => {
  const orig = globalThis.crypto;
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    // Swap in a crypto without randomUUID to force the byte-assembly branch.
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: orig.getRandomValues.bind(orig) }
    });
    const re = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
    assert.match(uuidV4(), re);
  } finally {
    Object.defineProperty(globalThis, 'crypto', desc);
  }
});

test('arrayBufferToBase64: round-trips bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 254, 255, 100, 200]);
  const b64 = arrayBufferToBase64(bytes.buffer);
  const back = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  assert.deepEqual([...back], [...bytes]);
});

test('arrayBufferToBase64: handles large buffers (>32KB chunk boundary)', () => {
  const big = new Uint8Array(70000).map((_, i) => i % 256);
  const b64 = arrayBufferToBase64(big.buffer);
  const back = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  assert.equal(back.length, 70000);
  assert.equal(back[69999], 69999 % 256);
});
