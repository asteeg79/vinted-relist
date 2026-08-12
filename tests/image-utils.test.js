import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAsBlob } from '../lib/image-utils.js';

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
