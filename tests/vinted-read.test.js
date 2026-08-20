import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHeaders, createVintedFetch } from '../lib/vinted-read.js';
import { ApiError, ValidationError } from '../lib/errors.js';

const AUTH = { csrf: 'csrf-token', anonId: 'anon-id' };
const ensureAuth = async () => AUTH;

function fakeFetch({ status = 200, body = '{"code":0}' } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

// ---------- headers ----------

test('readHeaders: exactly the set that turned 403 into 200 in the spike', () => {
  const h = readHeaders(AUTH);
  assert.equal(h['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(h['X-Enable-Multiple-Size-Groups'], 'true');
  assert.equal(h['X-Upload-Form'], 'true');
  assert.equal(h['X-CSRF-Token'], 'csrf-token');
  assert.equal(h['X-Anon-Id'], 'anon-id');
  assert.match(h['Accept'], /application\/json/);
});

test('readHeaders: no content type on a GET — only a body earns one', () => {
  assert.equal(readHeaders(AUTH)['Content-Type'], undefined);
  assert.equal(readHeaders(AUTH, { json: true })['Content-Type'], 'application/json');
});

test('readHeaders: a missing token is omitted, never sent empty', () => {
  const h = readHeaders({ csrf: null, anonId: null });
  assert.equal('X-CSRF-Token' in h, false);
  assert.equal('X-Anon-Id' in h, false);
});

// ---------- the transport ----------

test('fetchJson: builds the absolute URL from the domain and returns parsed JSON', async () => {
  const fetchImpl = fakeFetch({ body: '{"colors":[],"code":0}' });
  const fetchJson = createVintedFetch({ domain: 'www.vinted.de', ensureAuth, fetchImpl });

  const body = await fetchJson('/api/v2/item_upload/colors');
  assert.deepEqual(body, { colors: [], code: 0 });
  assert.equal(fetchImpl.calls[0].url, 'https://www.vinted.de/api/v2/item_upload/colors');
  assert.equal(fetchImpl.calls[0].init.credentials, 'include');
  assert.equal(fetchImpl.calls[0].init.headers['X-CSRF-Token'], 'csrf-token');
});

test('fetchJson: a POST carries its body and its content type', async () => {
  const fetchImpl = fakeFetch();
  const fetchJson = createVintedFetch({ domain: 'www.vinted.de', ensureAuth, fetchImpl });

  await fetchJson('/api/v2/item_upload/attributes', { method: 'POST', body: '{"attributes":[]}' });
  const { init } = fetchImpl.calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.body, '{"attributes":[]}');
  assert.equal(init.headers['Content-Type'], 'application/json');
});

test('fetchJson: the auth bundle is fetched per call, so a rotated token is picked up', async () => {
  let calls = 0;
  const rotating = async () => ({ csrf: 'csrf-' + (++calls), anonId: 'a' });
  const fetchImpl = fakeFetch();
  const fetchJson = createVintedFetch({ domain: 'www.vinted.de', ensureAuth: rotating, fetchImpl });

  await fetchJson('/a');
  await fetchJson('/b');
  assert.equal(fetchImpl.calls[0].init.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(fetchImpl.calls[1].init.headers['X-CSRF-Token'], 'csrf-2');
});

test('fetchJson: a non-2xx is an ApiError carrying the status', async () => {
  const fetchImpl = fakeFetch({ status: 403, body: '<!doctype html><html>…' });
  const fetchJson = createVintedFetch({ domain: 'www.vinted.de', ensureAuth, fetchImpl });

  await assert.rejects(() => fetchJson('/api/v2/item_upload/colors'), err => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 403);
    return true;
  });
});

test('fetchJson: a 200 that is not JSON is the defence page, not an answer', async () => {
  const fetchImpl = fakeFetch({ status: 200, body: '<!doctype html><html>…' });
  const fetchJson = createVintedFetch({ domain: 'www.vinted.de', ensureAuth, fetchImpl });

  await assert.rejects(() => fetchJson('/api/v2/item_upload/colors'), err => {
    assert.ok(err instanceof ValidationError);
    assert.match(err.message, /kein JSON/);
    return true;
  });
});

test('fetchJson: caller headers may add, and win on a collision', async () => {
  const fetchImpl = fakeFetch();
  const fetchJson = createVintedFetch({ domain: 'www.vinted.de', ensureAuth, fetchImpl });

  await fetchJson('/a', { headers: { 'Accept': 'text/plain', 'X-Extra': '1' } });
  const { headers } = fetchImpl.calls[0].init;
  assert.equal(headers['Accept'], 'text/plain');
  assert.equal(headers['X-Extra'], '1');
  assert.equal(headers['X-Requested-With'], 'XMLHttpRequest', 'the rest survives');
});
