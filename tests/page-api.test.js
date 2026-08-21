import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, ApiError, RateLimitError, NetworkError } from '../lib/errors.js';
import * as api from '../lib/page-api.js';
import { withRetry } from '../lib/retry.js';

let sendMessageImpl;
let lastMessage;

beforeEach(() => {
  lastMessage = null;
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: '{}' });
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1, url: 'https://www.vinted.de/items/123-foo', active: true }],
      sendMessage: async (_tabId, msg) => { lastMessage = msg; return sendMessageImpl(msg); }
    },
    scripting: { executeScript: async () => [] }
  };
});
afterEach(() => { delete globalThis.chrome; });

const AUTH = { csrf: 'csrf-1', anonId: 'anon-1' };

// ---------- fetchItemViaPage ----------
test('fetchItemViaPage: unwraps {item}', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: JSON.stringify({ item: { id: 123, title: 'X' } }) });
  const item = await api.fetchItemViaPage('www.vinted.de', AUTH, '123');
  assert.equal(item.id, 123);
  assert.equal(lastMessage.method, 'GET');
  assert.equal(lastMessage.path, '/api/v2/item_upload/items/123');
  assert.equal(lastMessage.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(lastMessage.headers['X-Anon-Id'], 'anon-1');
});

test('fetchItemViaPage: 401 → AuthError', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 401, contentType: 'application/json', body: '{}' });
  await assert.rejects(() => api.fetchItemViaPage('d', AUTH, '1'), AuthError);
});

test('fetchItemViaPage: 429 → RateLimitError', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 429, contentType: 'application/json', body: 'slow' });
  await assert.rejects(() => api.fetchItemViaPage('d', AUTH, '1'), RateLimitError);
});

test('fetchItemViaPage: 500 → ApiError', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 500, contentType: 'application/json', body: 'boom' });
  await assert.rejects(() => api.fetchItemViaPage('d', AUTH, '1'), ApiError);
});

test('fetchItemViaPage: non-JSON content type → ApiError', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'text/html', body: '<html>' });
  await assert.rejects(() => api.fetchItemViaPage('d', AUTH, '1'), /Expected JSON/);
});

test('fetchItemViaPage: content-script failure surfaces error', async () => {
  sendMessageImpl = async () => ({ ok: false, error: 'kaputt' });
  await assert.rejects(() => api.fetchItemViaPage('d', AUTH, '1'), /kaputt/);
});

// ---------- uploadPhotoViaPage ----------
test('uploadPhotoViaPage: builds multipart with temp_uuid, returns id + temp_uuid', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: JSON.stringify({ id: 999, temp_uuid: 'tu-1' }) });
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
  const r = await api.uploadPhotoViaPage('www.vinted.de', AUTH, blob, 'p.jpg', { tempUuid: 'sess-1' });
  assert.equal(r.id, 999);
  assert.equal(r.temp_uuid, 'tu-1');
  assert.equal(lastMessage.path, '/api/v2/photos');
  const names = lastMessage.multipart.map(p => p.name);
  assert.ok(names.includes('photo[temp_uuid]'));
  assert.ok(names.includes('photo[file]'));
  assert.ok(names.includes('photo[type]'));
  // multipart requests must NOT set JSON content-type
  assert.equal(lastMessage.headers['Content-Type'], undefined);
});

test('uploadPhotoViaPage: keeps high_resolution — that is the id the recognition wants', async () => {
  // Measured in the 0b spike (§6): `image_metadata[].image_id` is the STRING id under
  // `high_resolution`, not the numeric `id`. This return value used to drop it, and that
  // one omission made Entscheidung C dead code — `crossCheckWithVinted` could never build
  // an entry and returned early on every publish, logging nothing at all.
  sendMessageImpl = async () => ({
    ok: true, status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 999, temp_uuid: 'tu-1', high_resolution: { id: '03_00f15_MDsRx' } })
  });
  const blob = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
  const r = await api.uploadPhotoViaPage('www.vinted.de', AUTH, blob, 'p.jpg', {});
  assert.equal(r.high_resolution.id, '03_00f15_MDsRx');
});

test('uploadPhotoViaPage: finds high_resolution under a "photo" wrapper too', async () => {
  sendMessageImpl = async () => ({
    ok: true, status: 200, contentType: 'application/json',
    body: JSON.stringify({ photo: { id: 7, temp_uuid: 't', high_resolution: { id: 'abc' } } })
  });
  const blob = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
  const r = await api.uploadPhotoViaPage('d', AUTH, blob, 'p.jpg', {});
  assert.equal(r.id, 7);
  assert.equal(r.high_resolution.id, 'abc');
});

test('uploadPhotoViaPage: no high_resolution is null, never invented', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1, temp_uuid: 't' }) });
  const blob = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
  const r = await api.uploadPhotoViaPage('d', AUTH, blob, 'p.jpg', {});
  assert.equal(r.high_resolution, null);
});

test('uploadPhotoViaPage: omits temp_uuid part when not given', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1, temp_uuid: 't' }) });
  const blob = new Blob([new Uint8Array([9])], { type: 'image/jpeg' });
  await api.uploadPhotoViaPage('d', AUTH, blob, 'p.jpg', {});
  assert.ok(!lastMessage.multipart.some(p => p.name === 'photo[temp_uuid]'));
});

// ---------- createItemViaPage ----------
test('createItemViaPage: posts JSON payload with upload-form header', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: JSON.stringify({ item: { id: 555 } }) });
  const item = await api.createItemViaPage('www.vinted.de', AUTH, { item: { title: 'X' } });
  assert.equal(item.id, 555);
  assert.equal(lastMessage.method, 'POST');
  assert.equal(lastMessage.path, '/api/v2/item_upload/items');
  assert.equal(lastMessage.headers['X-Upload-Form'], 'true');
  assert.equal(lastMessage.headers['Content-Type'], 'application/json');
  assert.deepEqual(lastMessage.json, { item: { title: 'X' } });
});

// ---------- fetchCategoryAttributesViaPage ----------
test('fetchCategoryAttributesViaPage: sends the one body shape Vinted accepts', async () => {
  // Measured 2026-08-21: `{catalog_id, attributes: []}` → 200. `{catalog_id}` on its own
  // and `{attributes:[{code:'category',ids:[…]}]}` → 422. The empty `attributes` array is
  // not decoration.
  sendMessageImpl = async () => ({
    ok: true, status: 200, contentType: 'application/json',
    body: JSON.stringify({ code: 0, attributes: [{ code: 'language_book', value_ids: [] }] })
  });
  const attributes = await api.fetchCategoryAttributesViaPage('www.vinted.de', AUTH, 2319);
  assert.deepEqual(attributes, [{ code: 'language_book', value_ids: [] }]);
  assert.equal(lastMessage.method, 'POST');
  assert.equal(lastMessage.path, '/api/v2/item_upload/attributes');
  assert.deepEqual(lastMessage.json, { catalog_id: 2319, attributes: [] });
});

test('fetchCategoryAttributesViaPage: a body without the array is an empty list, not a crash', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: '{"code":0}' });
  assert.deepEqual(await api.fetchCategoryAttributesViaPage('www.vinted.de', AUTH, 1806), []);
});

// ---------- suggestPackageSizeViaPage ----------
test('suggestPackageSizeViaPage: goes to api.<domain>, not the marketplace host', async () => {
  // `https://www.vinted.de/shipping-estimation/…` answers with the 404 HTML page; the
  // shipping service lives on `api.vinted.de` (measured 2026-08-21 — and that is the host
  // the SPA itself calls on /items/new).
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: '{"package_size_id":2}' });
  const id = await api.suggestPackageSizeViaPage('www.vinted.de', {
    catalogId: 2319, brandId: null, sizeId: null, uploadSessionId: 'u-1', title: 'Roman', description: 'd', price: 4
  });
  assert.equal(id, 2);
  assert.equal(lastMessage.path, 'https://api.vinted.de/shipping-estimation/external/package_sizes/suggestion');
  assert.deepEqual(lastMessage.json, {
    catalog_id: 2319, brand_id: null, size_id: null,
    upload_session_id: 'u-1', title: 'Roman', description: 'd', price: 4
  });
});

test('suggestPackageSizeViaPage: carries no auth headers — the preflight refuses them', async () => {
  // With X-CSRF-Token / X-Requested-With the CORS preflight fails outright ("Failed to
  // fetch"); without them the answer is 200. The session travels in the cookies the
  // content script sends anyway.
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: '{"package_size_id":1}' });
  await api.suggestPackageSizeViaPage('www.vinted.de', { catalogId: 1806, uploadSessionId: 'u-1' });
  assert.deepEqual(Object.keys(lastMessage.headers).sort(), ['Accept', 'Content-Type']);
});

test('suggestPackageSizeViaPage: null is an answer, not a failure', async () => {
  // An unknown category is answered `{"package_size_id": null}` with status 200.
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: '{"package_size_id":null}' });
  assert.equal(await api.suggestPackageSizeViaPage('www.vinted.de', { catalogId: 999, uploadSessionId: 'u-1' }), null);
});

// ---------- deleteItemViaPage ----------
test('deleteItemViaPage: POSTs to /delete and resolves on 200', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: '{"code":0}' });
  await api.deleteItemViaPage('www.vinted.de', AUTH, '123');
  assert.equal(lastMessage.method, 'POST');
  assert.equal(lastMessage.path, '/api/v2/items/123/delete');
});

test('deleteItemViaPage: 401 → AuthError', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 401, contentType: 'application/json', body: '{}' });
  await assert.rejects(() => api.deleteItemViaPage('d', AUTH, '1'), AuthError);
});

test('deleteItemViaPage: 204 resolves', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 204, contentType: null, body: '' });
  await api.deleteItemViaPage('www.vinted.de', AUTH, '123');
  assert.equal(lastMessage.path, '/api/v2/items/123/delete');
});

test('deleteItemViaPage: an anti-bot HTML page → ApiError carrying the body', async () => {
  // relist.js sniffs ApiError bodies for Datadome/Cloudflare markers, so the delete path
  // must surface the HTML rather than silently reporting success.
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'text/html', body: '<html>captcha-delivery</html>' });
  await assert.rejects(() => api.deleteItemViaPage('d', AUTH, '1'), /Expected JSON/);
});

// ---------- every call classifies a reply the same way ----------
// The point of routing all five through decodeResponse: an operation that hand-rolls its
// own status handling drifts. deleteItemViaPage used to, and lost the 429 mapping.
const OPERATIONS = {
  fetchItem: () => api.fetchItemViaPage('d', AUTH, '1'),
  uploadPhoto: () => api.uploadPhotoViaPage('d', AUTH, new Blob([new Uint8Array([1])], { type: 'image/jpeg' }), 'p.jpg', {}),
  createItem: () => api.createItemViaPage('d', AUTH, { item: {} }, {}),
  deleteItem: () => api.deleteItemViaPage('d', AUTH, '1')
};

for (const [name, call] of Object.entries(OPERATIONS)) {
  test(`${name}: 401 → AuthError`, async () => {
    sendMessageImpl = async () => ({ ok: true, status: 401, contentType: 'application/json', body: '{}' });
    await assert.rejects(call, AuthError);
  });

  test(`${name}: 429 → RateLimitError (so withRetry backs off)`, async () => {
    sendMessageImpl = async () => ({ ok: true, status: 429, contentType: 'application/json', body: 'slow down' });
    await assert.rejects(call, RateLimitError);
  });

  test(`${name}: 503 → ApiError with the status kept`, async () => {
    sendMessageImpl = async () => ({ ok: true, status: 503, contentType: 'application/json', body: 'boom' });
    await assert.rejects(call, e => e instanceof ApiError && e.status === 503);
  });

  test(`${name}: non-JSON 200 → ApiError`, async () => {
    sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'text/html', body: '<html>' });
    await assert.rejects(call, ApiError);
  });
}

// ---------- the bug this seam existed to prevent ----------
test('a rate-limited delete is retried instead of failing outright', async () => {
  // A plain ApiError(429) would be classified non-retryable by withRetry and rethrown on
  // the first attempt — leaving the pipeline with a partial result and the user with a
  // manual delete. The delete runs last, right after the photo-upload burst, so it is the
  // call most likely to be throttled.
  let calls = 0;
  sendMessageImpl = async () => {
    calls++;
    return calls === 1
      ? { ok: true, status: 429, contentType: 'application/json', body: 'slow down' }
      : { ok: true, status: 200, contentType: 'application/json', body: '{"code":0,"message":"Ok"}' };
  };

  await withRetry(() => api.deleteItemViaPage('www.vinted.de', AUTH, '123'), { sleep: async () => {} });
  assert.equal(calls, 2, 'the 429 should have been retried');
});

test('no Vinted tab open → descriptive error', async () => {
  globalThis.chrome.tabs.query = async () => [];
  await assert.rejects(() => api.fetchItemViaPage('www.vinted.de', AUTH, '1'), /No Vinted tab open/);
});

test('auto-injects content script on "Receiving end" error, then retries', async () => {
  let calls = 0, injected = false;
  globalThis.chrome.scripting.executeScript = async () => { injected = true; return []; };
  sendMessageImpl = async () => {
    calls++;
    if (calls === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
    return { ok: true, status: 200, contentType: 'application/json', body: '{"item":{"id":7}}' };
  };
  const item = await api.fetchItemViaPage('www.vinted.de', AUTH, '1');
  assert.equal(item.id, 7);
  assert.ok(injected, 'should inject content script');
  assert.equal(calls, 2, 'should retry once after injection');
});

test('uploadPhotoViaPage: 204 returns null', async () => {
  sendMessageImpl = async () => ({ ok: true, status: 204, contentType: 'application/json', body: '' });
  const blob = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
  const r = await api.uploadPhotoViaPage('d', AUTH, blob, 'p.jpg', {});
  assert.equal(r, null);
});

test('fetchItemViaPage: sends X-Upload-Form so the edit fields come back', async () => {
  // The condition + size fields vanished from this endpoint's response on 2026-08-12.
  // The SPA's own edit form sets this header on the item_upload surface; we now match it.
  sendMessageImpl = async () => ({ ok: true, status: 200, contentType: 'application/json', body: '{"item":{"id":1}}' });
  await api.fetchItemViaPage('www.vinted.de', AUTH, '1');
  assert.equal(lastMessage.headers['X-Upload-Form'], 'true');
});

// ---------- transport failures are typed so they can be retried ----------
test('a page-side "Failed to fetch" surfaces as a retryable NetworkError', async () => {
  sendMessageImpl = async () => ({ ok: false, error: 'Failed to fetch' });
  await assert.rejects(() => api.uploadPhotoViaPage('d', AUTH, new Blob([new Uint8Array([1])]), 'p.jpg', {}), NetworkError);
});

test('a missing content-script reply is a NetworkError', async () => {
  sendMessageImpl = async () => undefined;
  await assert.rejects(() => api.fetchItemViaPage('d', AUTH, '1'), NetworkError);
});

test('"no Vinted tab open" stays a plain non-retryable Error', async () => {
  globalThis.chrome.tabs.query = async () => [];
  await assert.rejects(() => api.fetchItemViaPage('www.vinted.de', AUTH, '1'), e => {
    assert.ok(!(e instanceof NetworkError), 'must not be retryable — the user has to open a tab');
    assert.match(e.message, /No Vinted tab open/);
    return true;
  });
});

test('a failed auto-inject stays non-retryable', async () => {
  globalThis.chrome.scripting.executeScript = async () => { throw new Error('cannot inject'); };
  sendMessageImpl = async () => { throw new Error('Receiving end does not exist'); };
  await assert.rejects(() => api.fetchItemViaPage('www.vinted.de', AUTH, '1'), e => {
    assert.ok(!(e instanceof NetworkError), 'the tab needs a manual reload; retrying is pointless');
    assert.match(e.message, /Auto-inject failed/);
    return true;
  });
});

test('a transient blip on one photo no longer aborts the upload', async () => {
  let calls = 0;
  sendMessageImpl = async () => {
    calls++;
    return calls === 1
      ? { ok: false, error: 'Failed to fetch' }
      : { ok: true, status: 200, contentType: 'application/json', body: '{"id":7,"temp_uuid":"t"}' };
  };
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  const r = await withRetry(() => api.uploadPhotoViaPage('www.vinted.de', AUTH, blob, 'p.jpg', {}), { sleep: async () => {} });
  assert.equal(r.id, 7);
  assert.equal(calls, 2);
});
