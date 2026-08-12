import { log } from './logger.js';

/**
 * Authentication & session handling.
 *
 * Vinted's state-changing API calls require an `X-CSRF-Token` and `X-Anon-Id` header
 * (the session itself rides along in HttpOnly cookies the browser sends automatically).
 * The hard part is obtaining the CSRF token, because:
 *   - It is NOT in a cookie JS can read (the session cookies are HttpOnly).
 *   - It is NOT in a <meta> tag (Vinted is a Next.js app).
 *   - It lives as `"CSRF_TOKEN":"<uuid>"` inside an inline <script> on authenticated pages.
 *
 * This module gathers tokens from three sources, in order of freshness/reliability:
 *   1. Live snooping — the SW's webRequest listener captures the headers off the SPA's
 *      own API calls (always current). Stored under `liveTokens`.
 *   2. A persisted per-domain session (`sessions`) from a previous run.
 *   3. A last-resort HTML scrape of an authenticated page (edit / new / member).
 */

const TOKENS_KEY = 'liveTokens';
const SESSION_KEY = 'sessions';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

// ---- Pure helpers (no chrome.* — fully unit-testable) ----

/**
 * Pull CSRF + anon id out of a webRequest header array.
 * Header names are matched case-insensitively (browsers may normalise casing).
 */
export function extractTokensFromHeaders(headers = []) {
  let csrf = null, anonId = null;
  for (const h of headers) {
    const n = (h?.name || '').toLowerCase();
    if (n === 'x-csrf-token' && h.value) csrf = h.value;
    else if (n === 'x-anon-id' && h.value) anonId = h.value;
  }
  return { csrf, anonId };
}

/**
 * Find the CSRF token inside an authenticated page's HTML.
 * Two patterns, tried in order:
 *   1. `"CSRF_TOKEN":"<uuid>"` — the canonical inline-config form. The `[\\\\":\s]+`
 *      bridge tolerates escaped quotes/colons as they appear inside RSC stream chunks
 *      (e.g. `\"CSRF_TOKEN\":\"…\"`). Case-insensitive because the key is uppercase.
 *   2. A looser "any uuid within 200 chars after the word csrf" fallback.
 */
export function extractCsrfFromHtml(html) {
  if (!html) return null;
  const m = html.match(new RegExp(`CSRF_TOKEN[\\\\":\\s]+(${UUID})`, 'i'))
        || html.match(new RegExp(`csrf.{0,200}?(${UUID})`, 'is'));
  return m ? m[1] : null;
}

// ---- Live token store (populated by the webRequest snooper in service-worker.js) ----

/** Merge freshly snooped tokens for a domain (keeps the other token if only one updates). */
export async function saveLiveTokens(domain, { csrf, anonId }) {
  const { [TOKENS_KEY]: m = {} } = await chrome.storage.local.get(TOKENS_KEY);
  m[domain] = {
    ...(m[domain] || {}),
    ...(csrf ? { csrf } : {}),     // only overwrite csrf when we actually captured one
    ...(anonId ? { anonId } : {}), // ditto for anonId
    ts: Date.now()
  };
  await chrome.storage.local.set({ [TOKENS_KEY]: m });
}

export async function getLiveTokens(domain) {
  const { [TOKENS_KEY]: m = {} } = await chrome.storage.local.get(TOKENS_KEY);
  return m[domain] || null;
}

// ---- Persisted per-domain session ----

async function loadSessions() {
  const { [SESSION_KEY]: s = {} } = await chrome.storage.local.get(SESSION_KEY);
  return s;
}

/**
 * Upsert (merge) the stored session for a domain.
 *
 * Null/undefined fields are DROPPED rather than written. A caller that failed to find a
 * token passes null for it, and merging that null would erase a good token acquired
 * earlier — turning "I have nothing new" into "forget what you had".
 * saveLiveTokens has always guarded this way; this function used to not.
 */
export async function saveSession(domain, data) {
  const fresh = Object.fromEntries(Object.entries(data || {}).filter(([, v]) => v != null));
  const s = await loadSessions();
  s[domain] = { ...(s[domain] || {}), ...fresh, ts: Date.now() };
  await chrome.storage.local.set({ [SESSION_KEY]: s });
}

export async function getSession(domain) {
  const s = await loadSessions();
  return s[domain] || null;
}

// ---- Cookie + CSRF acquisition ----

/**
 * Read the (mostly JS-invisible) Vinted cookies via the privileged chrome.cookies API.
 * The SW can read HttpOnly cookies this way; a content script's document.cookie cannot.
 * chrome.cookies.get is callback-based, hence the Promise wrappers.
 */
export async function readCookies(domain) {
  const url = `https://${domain}`;
  const names = ['v_udt', 'v_uid', 'v_sid', 'anon_id', 'anonymous-id', 'access_token_web'];
  const entries = await Promise.all(names.map(name => new Promise(resolve => {
    chrome.cookies.get({ url, name }, c => resolve([name, c?.value || null]));
  })));
  return Object.fromEntries(entries);
}

/** Fetch each candidate page until one yields a CSRF token. Returns { token, path } or null. */
export async function fetchCsrfFromHtml(domain, paths) {
  for (const path of paths) {
    const r = await fetch(`https://${domain}${path}`, {
      credentials: 'include',
      redirect: 'follow',
      headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' }
    });
    if (!r.ok) continue; // skip redirects-to-login / errors, try the next path
    const token = extractCsrfFromHtml(await r.text());
    if (token) return { token, path };
  }
  return null;
}

/**
 * Assemble the auth bundle { csrf, anonId, vUdt, vUid } for a domain.
 *
 * Resolution order (each step only fills what's still missing):
 *   1. Cookies → anonId / vUdt / vUid (csrf is never in a readable cookie).
 *   2. Live snooped tokens → csrf + anonId (freshest, matches the SPA exactly).
 *   3. Stored session → csrf (from a previous run).
 *   4. HTML scrape of /items/{id}/edit, /items/new, /member/{vUid} → csrf.
 * Finally the result is persisted back to the session for next time.
 */
export async function ensureAuth(domain, itemId) {
  const cookies = await readCookies(domain);
  const auth = {
    csrf: null,
    anonId: cookies['anon_id'] || cookies['anonymous-id'] || null,
    vUdt: cookies['v_udt'] || null,
    vUid: cookies['v_uid'] || null
  };

  // Prefer freshly snooped tokens — they're guaranteed in sync with the live SPA session.
  const live = await getLiveTokens(domain);
  if (live?.csrf) auth.csrf = live.csrf;
  if (live?.anonId) auth.anonId = live.anonId;

  // Otherwise fall back to a token persisted from an earlier run.
  const sess = await getSession(domain);
  if (!auth.csrf && sess?.csrf) auth.csrf = sess.csrf;

  // Last resort: scrape it from an authenticated page's HTML.
  if (!auth.csrf) {
    await log('csrf_lookup', { domain, itemId });
    const found = await fetchCsrfFromHtml(domain, [
      `/items/${itemId}/edit`,
      `/items/new`,
      `/member/${auth.vUid || ''}`
    ].filter(p => !p.endsWith('/'))); // drop /member/ when vUid is unknown
    if (found) {
      auth.csrf = found.token;
      await log('csrf_acquired', { from: found.path });
    } else {
      await log('csrf_not_found', {});
    }
  } else if (live?.csrf) {
    await log('csrf_from_live', {});
  }

  await saveSession(domain, { csrf: auth.csrf, anonId: auth.anonId, vUdt: auth.vUdt, vUid: auth.vUid });
  return auth;
}
