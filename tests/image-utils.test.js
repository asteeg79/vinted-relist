import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAsBlob, base64ToBlob } from '../lib/image-utils.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('fetchAsBlob: returns blob on ok response', async () => {
  const expected = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  globalThis.fetch = async (url, opts) => {
    assert.equal(opts.credentials, 'omit');  // CDN images fetched without cookies
    return { ok: true, blob: async () => expected };
  };
  const b = await fetchAsBlob('https://images1.vinted.net/x.jpg');
  assert.equal(b, expected);
});

test('fetchAsBlob: throws on non-ok response', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(() => fetchAsBlob('https://x/y.jpg'), /Photo fetch failed: 403/);
});

test('base64ToBlob: rebuilds the photo the studio sent over chrome messaging', async () => {
  const bytes = new Uint8Array([255, 216, 255, 0, 1, 2]);
  const base64 = Buffer.from(bytes).toString('base64');
  const blob = base64ToBlob(base64, 'image/jpeg');
  assert.equal(blob.type, 'image/jpeg');
  assert.equal(blob.size, bytes.length);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [...bytes]);
});

test('base64ToBlob: defaults to JPEG, which is what the canvas produces', () => {
  assert.equal(base64ToBlob('AAAA').type, 'image/jpeg');
});
