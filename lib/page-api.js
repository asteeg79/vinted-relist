/**
 * Vinted API client — but every request is executed *inside a Vinted tab*, not from the
 * service worker.
 *
 * Why: Vinted rejects state-changing requests whose `Origin` isn't a real vinted.* page
 * (a CSRF defence). A fetch from the SW has Origin `chrome-extension://…` and gets 403.
 * So the SW packages each request as an `api/call` message, sends it to the content
 * script running in a Vinted tab, and the content script does the actual `fetch()` —
 * which then carries the correct same-origin Origin and the user's cookies.
 *
 * This module is the SW-side half: pick a tab, send the message, decode the reply, and
 * translate non-2xx responses into typed errors.
 */
import { ApiError, AuthError, RateLimitError, NetworkError } from './errors.js';
import { tabMatchPatterns } from './domains.js';
import { arrayBufferToBase64 } from './util.js';

/**
 * Choose which Vinted tab should execute the request.
 * Preference order:
 *   1. A tab already open on the exact item being relisted (most "natural").
 *   2. The active tab on the domain.
 *   3. Any tab on the domain, then any Vinted tab at all.
 */
async function findVintedTab(domain, preferItemId) {
  const exact = await chrome.tabs.query({ url: `https://${domain}/*` });
  if (preferItemId) {
    const onItem = exact.find(t => t.url?.includes(`/items/${preferItemId}`));
    if (onItem) return onItem;
  }
  const active = exact.find(t => t.active);
  if (active) return active;
  if (exact[0]) return exact[0];
  const any = await chrome.tabs.query({ url: tabMatchPatterns() });
  return any[0] || null;
}

/**
 * Build the header set Vinted expects.
 *  - `X-Enable-Multiple-Size-Groups` / `X-Upload-Form`: flags the SPA sends on the
 *    item-upload endpoints; mirroring them keeps us indistinguishable from the real UI.
 *  - JSON requests get `Content-Type: application/json`; multipart requests must NOT set
 *    it (the browser adds the multipart boundary itself — see the content script).
 *  - CSRF + anon id are the actual auth; cookies travel automatically with credentials.
 */
function authHeaders(auth, { multipart = false, uploadForm = false } = {}) {
  const h = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Enable-Multiple-Size-Groups': 'true'
  };
  if (!multipart) h['Content-Type'] = 'application/json';
  if (uploadForm) h['X-Upload-Form'] = 'true';
  if (auth?.csrf) h['X-CSRF-Token'] = auth.csrf;
  if (auth?.anonId) h['X-Anon-Id'] = auth.anonId;
  return h;
}

/**
 * Programmatically inject the content scripts (used when a tab predates the extension
 * load). Order matters and must match manifest.json: content.js calls into the global
 * that page-call.js defines, so page-call.js has to be evaluated first.
 */
const CONTENT_SCRIPTS = ['content/page-call.js', 'content/card-policy.js', 'content/content.js'];

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPTS
  });
}

/**
 * Send one request to the content script and return its raw reply { status, contentType, body }.
 * If the tab has no content script yet (it was open before the extension was installed/
 * updated), the first sendMessage throws "Receiving end does not exist" — we then inject
 * the script and retry exactly once.
 */
async function pageApiCall(domain, payload, opts = {}) {
  const tab = await findVintedTab(domain, opts.preferItemId);
  if (!tab) {
    throw new Error(`No Vinted tab open on ${domain}. Open the site in a tab and try again.`);
  }
  payload._tabUrl = tab.url; // surfaced in diagnostics so we know which tab ran the call
  const send = () => chrome.tabs.sendMessage(tab.id, { type: 'api/call', ...payload });

  let response;
  try {
    response = await send();
  } catch (e) {
    if (/Receiving end does not exist|Could not establish connection/i.test(e.message || '')) {
      try {
        await injectContentScript(tab.id);
        response = await send(); // retry once now that the listener exists
      } catch (e2) {
        throw new Error(`Auto-inject failed in tab ${tab.id}: ${e2.message}. Reload the Vinted tab manually.`);
      }
    } else {
      throw new NetworkError(`Could not reach content script in tab ${tab.id}: ${e.message}.`);
    }
  }
  if (!response) throw new NetworkError('Content script returned no response.');
  // A page-side fetch failure ('Failed to fetch') is transient — typed so withRetry sees it.
  if (!response.ok) throw new NetworkError(response.error || 'Content-script fetch failed.');
  // A body that decoded to the wrong size would upload a truncated photo. Treat it as a
  // transient transport failure so withRetry re-sends it rather than corrupting a listing.
  if (response.warnings?.length) {
    throw new NetworkError(`Request body did not survive transport: ${response.warnings.join('; ')}`);
  }
  response._tabUrl = tab.url;
  return response;
}

/**
 * Turn a content-script reply into parsed JSON, or throw a typed error. This is the ONE
 * place that decides what a Vinted HTTP reply means — every call below goes through it.
 *
 * Maps 401→AuthError, 429→RateLimitError, other non-2xx→ApiError, and a non-JSON body
 * (e.g. an HTML error/anti-bot page) → ApiError with a snippet for diagnosis. A 204 or an
 * empty body returns null, since there is nothing to parse.
 *
 * The typing matters beyond diagnostics: retry.js branches on the error *class*, so a
 * reply classified as a plain ApiError instead of a RateLimitError is treated as
 * non-retryable. deleteItemViaPage used to hand-roll this and lost the 429 mapping,
 * which meant the last call in the pipeline was the only one without backoff.
 */
function decodeResponse(r) {
  if (r.status === 401) throw new AuthError('Not logged in (401).');
  if (r.status === 429) throw new RateLimitError(r.body);
  if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, r.body);
  if (r.status === 204) return null; // No Content — by definition no body to decode
  if (!r.contentType || !r.contentType.includes('json')) {
    throw new ApiError(r.status,
      `Expected JSON but got ${r.contentType || 'no content-type'}. First 200 chars: ${(r.body || '').slice(0, 200)}`);
  }
  return r.body ? JSON.parse(r.body) : null;
}

/**
 * GET the full editable item (rich JSON incl. condition, size, colours, brand, photos).
 *
 * `X-Upload-Form: true` mirrors what the SPA's own edit form sends on this endpoint (it
 * was previously set only on the create call). NOTE: this was tried as a fix for the
 * condition/size fields disappearing on 2026-08-12 and did NOT restore them — the key set
 * is the same with and without it. Kept only because matching the SPA's headers is the
 * house style here; it is not the explanation.
 */
export async function fetchItemViaPage(domain, auth, itemId) {
  const r = await pageApiCall(domain, {
    method: 'GET',
    path: `/api/v2/item_upload/items/${itemId}`,
    headers: authHeaders(auth, { uploadForm: true })
  }, { preferItemId: itemId });
  const parsed = decodeResponse(r);
  return parsed?.item ?? parsed; // endpoint wraps the item in { item: … }
}

/**
 * Upload one photo.
 * The blob is base64-encoded for transport (chrome messaging can't carry a Blob), then
 * reconstructed and sent as multipart/form-data by the content script. `tempUuid` binds
 * the photo to the shared upload session — without it Vinted later rejects the photo.
 * Returns { id, temp_uuid }: the integer `id` goes into assigned_photos, the temp_uuid
 * is the session id reused on the create call.
 */
export async function uploadPhotoViaPage(domain, auth, blob, filename, opts = {}) {
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);
  const multipart = [
    { name: 'photo[type]', kind: 'text', value: 'item' },
    { name: 'photo[file]', kind: 'blob_b64', data: base64, contentType: blob.type || 'image/jpeg', filename, expectedSize: arrayBuffer.byteLength }
  ];
  if (opts.tempUuid) {
    // Prepend so the session binding is set before the file part is parsed.
    multipart.unshift({ name: 'photo[temp_uuid]', kind: 'text', value: opts.tempUuid });
  }
  const r = await pageApiCall(domain, {
    method: 'POST',
    path: '/api/v2/photos',
    headers: authHeaders(auth, { multipart: true }),
    multipart
  }, { preferItemId: opts.preferItemId });
  const parsed = decodeResponse(r);
  if (!parsed) return null; // 204 no-content (shouldn't normally happen for uploads)
  return { id: parsed.id ?? parsed.photo?.id, temp_uuid: parsed.temp_uuid ?? parsed.photo?.temp_uuid, tabUrl: r._tabUrl };
}

/** POST the assembled payload to create the new listing; returns the new item (with id). */
export async function createItemViaPage(domain, auth, fullPayload, opts = {}) {
  const r = await pageApiCall(domain, {
    method: 'POST',
    path: '/api/v2/item_upload/items',
    headers: authHeaders(auth, { uploadForm: true }),
    json: fullPayload
  }, { preferItemId: opts.preferItemId });
  const parsed = decodeResponse(r);
  return parsed?.item ?? parsed;
}

/**
 * Delete a listing.
 * Note: Vinted uses POST `/api/v2/items/{id}/delete` — NOT the HTTP DELETE verb (the old
 * `DELETE /api/v2/items/{id}` route returns 404 on the current API). A success replies
 * either 204 or `{code: 0, message: "Ok"}`; the body is of no use to the caller, so only
 * the throw matters here.
 */
export async function deleteItemViaPage(domain, auth, itemId) {
  const r = await pageApiCall(domain, {
    method: 'POST',
    path: `/api/v2/items/${itemId}/delete`,
    headers: authHeaders(auth)
  }, { preferItemId: itemId });
  decodeResponse(r);
}
