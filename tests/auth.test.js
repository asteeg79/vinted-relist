import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import {
  extractTokensFromHeaders, extractCsrfFromHtml,
  saveLiveTokens, getLiveTokens, saveSession, getSession,
  readCookies, fetchCsrfFromHtml, ensureAuth
} from '../lib/auth.js';

const realFetch = globalThis.fetch;
beforeEach(() => installChromeMock());
afterEach(() => { globalThis.fetch = realFetch; });

// ---------- extractTokensFromHeaders (pure) ----------
test('extractTokensFromHeaders: picks csrf + anon id case-insensitively', () => {
  const r = extractTokensFromHeaders([
    { name: 'X-CSRF-Token', value: 'abc' },
    { name: 'x-anon-id', value: 'anon-1' },
    { name: 'Content-Type', value: 'application/json' }
  ]);
  assert.deepEqual(r, { csrf: 'abc', anonId: 'anon-1' });
});

test('extractTokensFromHeaders: empty / missing → nulls', () => {
  assert.deepEqual(extractTokensFromHeaders([]), { csrf: null, anonId: null });
  assert.deepEqual(extractTokensFromHeaders(), { csrf: null, anonId: null });
});

// ---------- extractCsrfFromHtml (pure) ----------
test('extractCsrfFromHtml: uppercase CSRF_TOKEN with escaped quotes', () => {
  const html = 'foo\\"CSRF_TOKEN\\":\\"75f6c9fa-dc8e-4e52-a000-e09dd4084b3e\\",bar';
  assert.equal(extractCsrfFromHtml(html), '75f6c9fa-dc8e-4e52-a000-e09dd4084b3e');
});

test('extractCsrfFromHtml: generic csrf-near-uuid fallback', () => {
  const html = '<meta name="csrf-token" content="11111111-2222-4333-8444-555555555555">';
  assert.equal(extractCsrfFromHtml(html), '11111111-2222-4333-8444-555555555555');
});

test('extractCsrfFromHtml: returns null when absent', () => {
  assert.equal(extractCsrfFromHtml('<html>no token here</html>'), null);
  assert.equal(extractCsrfFromHtml(''), null);
});

// ---------- live tokens (chrome.storage) ----------
test('saveLiveTokens + getLiveTokens: round trip per domain', async () => {
  await saveLiveTokens('www.vinted.de', { csrf: 'c1', anonId: 'a1' });
  const t = await getLiveTokens('www.vinted.de');
  assert.equal(t.csrf, 'c1');
  assert.equal(t.anonId, 'a1');
  assert.ok(t.ts > 0);
});

test('saveLiveTokens: merges, keeps anonId when only csrf updates', async () => {
  await saveLiveTokens('www.vinted.de', { csrf: 'c1', anonId: 'a1' });
  await saveLiveTokens('www.vinted.de', { csrf: 'c2' });
  const t = await getLiveTokens('www.vinted.de');
  assert.equal(t.csrf, 'c2');
  assert.equal(t.anonId, 'a1');
});

test('getLiveTokens: null for unknown domain', async () => {
  assert.equal(await getLiveTokens('www.vinted.fr'), null);
});

// ---------- sessions (chrome.storage) ----------
test('saveSession + getSession: round trip and merge', async () => {
  await saveSession('www.vinted.de', { csrf: 'x', vUid: '42' });
  await saveSession('www.vinted.de', { csrf: 'y' });
  const s = await getSession('www.vinted.de');
  assert.equal(s.csrf, 'y');
  assert.equal(s.vUid, '42');
});

test('getSession: null for unknown domain', async () => {
  assert.equal(await getSession('nope.vinted.de'), null);
});

test('saveSession: a null field never erases a stored value', async () => {
  // The bug this guards: a caller that found no token passes csrf:null, and merging that
  // null turned "nothing new to report" into "forget the token you had", forcing an
  // unnecessary HTML scrape on the next run.
  await saveSession('www.vinted.de', { csrf: 'good-token', anonId: 'anon-1', vUid: '42' });
  await saveSession('www.vinted.de', { csrf: null, anonId: undefined, vUid: '42' });

  const s = await getSession('www.vinted.de');
  assert.equal(s.csrf, 'good-token', 'csrf must survive a null write');
  assert.equal(s.anonId, 'anon-1', 'anonId must survive an undefined write');
});

test('saveSession: a non-null field still overwrites', async () => {
  await saveSession('www.vinted.de', { csrf: 'old' });
  await saveSession('www.vinted.de', { csrf: 'new' });
  assert.equal((await getSession('www.vinted.de')).csrf, 'new');
});

test('saveSession: falsy-but-real values are kept, not treated as absent', async () => {
  await saveSession('www.vinted.de', { vUid: 0, csrf: '' });
  const s = await getSession('www.vinted.de');
  assert.equal(s.vUid, 0);
  assert.equal(s.csrf, '');
});

test('saveSession: an all-null write still stamps ts without touching fields', async () => {
  await saveSession('www.vinted.de', { csrf: 'keep' });
  const before = await getSession('www.vinted.de');
  await saveSession('www.vinted.de', { csrf: null, anonId: null, vUdt: null, vUid: null });
  const after = await getSession('www.vinted.de');
  assert.equal(after.csrf, 'keep');
  assert.ok(after.ts >= before.ts);
});

test('ensureAuth: falls back to the stored session token and re-persists it', async () => {
  // No live tokens and a failing HTML scrape — the token from a previous run is the only
  // source left, and must survive the write-back at the end of ensureAuth.
  installChromeMock({ sessions: { 'www.vinted.de': { csrf: 'previous-token' } } }, {});
  globalThis.fetch = async () => ({ ok: false, text: async () => '' });

  const auth = await ensureAuth('www.vinted.de', '123');
  assert.equal(auth.csrf, 'previous-token', 'falls back to the stored token');
  assert.equal((await getSession('www.vinted.de')).csrf, 'previous-token', 'and keeps it stored');
  delete globalThis.fetch;
});

// ---------- readCookies (chrome.cookies) ----------
test('readCookies: returns requested cookie values, null for missing', async () => {
  installChromeMock({}, { anon_id: 'anon-9', v_uid: '290119478' });
  const c = await readCookies('www.vinted.de');
  assert.equal(c['anon_id'], 'anon-9');
  assert.equal(c['v_uid'], '290119478');
  assert.equal(c['v_udt'], null);
});

// ---------- fetchCsrfFromHtml (fetch) ----------
test('fetchCsrfFromHtml: returns token from first page that has one', async () => {
  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () => url.includes('/edit')
      ? 'x \\"CSRF_TOKEN\\":\\"75f6c9fa-dc8e-4e52-a000-e09dd4084b3e\\" y'
      : 'no token'
  });
  const found = await fetchCsrfFromHtml('www.vinted.de', ['/items/1/edit', '/items/new']);
  assert.equal(found.token, '75f6c9fa-dc8e-4e52-a000-e09dd4084b3e');
  assert.equal(found.path, '/items/1/edit');
});

test('fetchCsrfFromHtml: null when no page yields a token', async () => {
  globalThis.fetch = async () => ({ ok: true, text: async () => 'nothing here' });
  assert.equal(await fetchCsrfFromHtml('www.vinted.de', ['/a', '/b']), null);
});

test('fetchCsrfFromHtml: skips non-ok responses', async () => {
  globalThis.fetch = async (url) => url.includes('/b')
    ? { ok: true, text: async () => 'CSRF_TOKEN":"11111111-2222-4333-8444-555555555555"' }
    : { ok: false, text: async () => '' };
  const found = await fetchCsrfFromHtml('www.vinted.de', ['/a', '/b']);
  assert.equal(found.path, '/b');
});

// ---------- ensureAuth (orchestration) ----------
test('ensureAuth: uses live tokens + cookies, no HTML fetch needed', async () => {
  installChromeMock(
    { liveTokens: { 'www.vinted.de': { csrf: 'live-csrf', anonId: 'live-anon' } } },
    { v_uid: '42', v_udt: 'udt-1', anon_id: 'cookie-anon' }
  );
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: false, text: async () => '' }; };

  const auth = await ensureAuth('www.vinted.de', '123');
  assert.equal(auth.csrf, 'live-csrf');
  assert.equal(auth.anonId, 'live-anon');   // live wins over cookie
  assert.equal(auth.vUid, '42');
  assert.equal(fetched, false);             // no scrape when csrf already known
  // persisted to session
  assert.equal((await getSession('www.vinted.de')).csrf, 'live-csrf');
});

test('ensureAuth: scrapes CSRF from HTML when no live/session token', async () => {
  installChromeMock({}, { anon_id: 'cookie-anon', v_uid: '42' });
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => 'CSRF_TOKEN":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"'
  });
  const auth = await ensureAuth('www.vinted.de', '123');
  assert.equal(auth.csrf, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(auth.anonId, 'cookie-anon');
});
