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
import { tabMatchPatterns, apiHostFor } from './domains.js';
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
  const photo = parsed.photo ?? parsed;
  return {
    id: parsed.id ?? parsed.photo?.id,
    temp_uuid: parsed.temp_uuid ?? parsed.photo?.temp_uuid,
    // The string id Vinteds own photo recognition wants as `image_id` — NOT the numeric
    // `id`, as the 0b spike measured explicitly (§6). It used to be dropped here, which
    // made the cross-check of Entscheidung C dead code: `crossCheckWithVinted` could never
    // assemble an `image_metadata` entry and returned early on every single publish.
    high_resolution: photo.high_resolution ?? null,
    tabUrl: r._tabUrl
  };
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
 * Vinteds eigene Fotoerkennung: which categories it sees in the uploaded images.
 *
 * Measured in the 0b spike — it needs nothing but the image ids and the upload session,
 * no title and no description. `image_id` is the STRING from the photo response's
 * `high_resolution.id`, not the numeric photo id (docs §6).
 *
 * Routed through the content script like every other POST: these were never tested from
 * an extension origin, and ADR-0001 is about state-changing requests.
 */
export async function suggestCategoriesViaPage(domain, auth, { imageMetadata, uploadSessionId }) {
  const r = await pageApiCall(domain, {
    method: 'POST',
    path: '/api/v2/item_upload/suggestions/categories',
    headers: authHeaders(auth, { uploadForm: true }),
    json: { image_metadata: imageMetadata, upload_session_id: uploadSessionId }
  });
  const parsed = decodeResponse(r);
  return parsed?.categories || [];
}

/** The same flow's brand/colour/size suggestions for an already-chosen category. */
export async function suggestAttributesViaPage(domain, auth, { imageMetadata, uploadSessionId, categoryId }) {
  const r = await pageApiCall(domain, {
    method: 'POST',
    path: '/api/v2/item_upload/suggestions/attributes',
    headers: authHeaders(auth, { uploadForm: true }),
    json: {
      title: '',
      description: '',
      category_id: categoryId,
      image_metadata: imageMetadata,
      upload_session_id: uploadSessionId,
      attributes: categoryId == null ? [] : [{ code: 'category', ids: [String(categoryId)] }]
    }
  });
  const parsed = decodeResponse(r);
  // `isbn` GEHÖRT DAZU. Vinted liest sie aus den Fotos und nennt sie hier — und für eine
  // Buchkategorie verlangt der Create sie: `400 isbn: Bitte gib eine ISBN an`. Sie hier
  // wegzulassen war dieselbe Sorte Verlust wie einst `high_resolution`: gemessen,
  // dokumentiert, und dann an der Naht fallen gelassen.
  return {
    brands: parsed?.brands || [],
    colors: parsed?.colors || [],
    sizes: parsed?.sizes || [],
    isbn: parsed?.isbn ?? null
  };
}

/**
 * Welche Attribute diese Kategorie überhaupt kennt.
 *
 * Der Auto-Listing-Pfad hat keinen Vorgänger-Artikel, aus dem er `item_attributes`
 * abschreiben könnte (im Relist-Pfad ist genau das die Lösung — siehe `lib/item.js`). Also
 * wird gefragt, statt `[]` anzunehmen.
 *
 * Gemessen 2026-08-21: `{catalog_id, attributes: []}` → `200 {"attributes":[]}`. Andere
 * Körper (`{catalog_id}` allein, `{attributes:[{code:'category',ids:[…]}]}`) → `422`. Für
 * jede geprüfte Kategorie — Kleidung, Schuhe, Bücher — ist die Liste leer; ein nicht-leeres
 * Ergebnis ist also der Ausnahmefall, für den `draft.js` den Draft anhält.
 */
export async function fetchCategoryAttributesViaPage(domain, auth, catalogId) {
  const r = await pageApiCall(domain, {
    method: 'POST',
    path: '/api/v2/item_upload/attributes',
    headers: authHeaders(auth, { uploadForm: true }),
    json: { catalog_id: catalogId, attributes: [] }
  });
  const parsed = decodeResponse(r);
  return Array.isArray(parsed?.attributes) ? parsed.attributes : [];
}

/**
 * Vinteds eigener Vorschlag für die Sendungsgröße.
 *
 * ZWEI DINGE SIND HIER ANDERS ALS BEI JEDEM ANDEREN AUFRUF, beide gemessen 2026-08-21 im
 * laufenden `/items/new`:
 *
 *   1. **Ein anderer Host.** `api.vinted.de`, nicht `www.vinted.de` — dort ist es die
 *      404-HTML-Seite. Deshalb steht hier eine absolute URL; das Content-Skript reicht
 *      `path` unverändert an `fetch` weiter.
 *   2. **Keine Auth-Header.** `X-CSRF-Token` und `X-Requested-With` stehen nicht in der
 *      CORS-Erlaubnis des Versand-Dienstes: mit ihnen scheitert schon der Preflight
 *      ("Failed to fetch"), ohne sie antwortet er 200. Die Anmeldung passiert über die
 *      Cookies, die das Content-Skript ohnehin mitschickt (`credentials: 'include'`) —
 *      ohne sie ist die Antwort 403.
 *
 * `upload_session_id` ist Pflicht (sonst 422). Eine unbekannte Kategorie beantwortet Vinted
 * mit `{"package_size_id": null}` — null ist also eine gültige Antwort und kein Fehler.
 */
export async function suggestPackageSizeViaPage(domain, { catalogId, brandId, sizeId, uploadSessionId, title, description, price }) {
  const r = await pageApiCall(domain, {
    method: 'POST',
    path: `https://${apiHostFor(domain)}/shipping-estimation/external/package_sizes/suggestion`,
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    json: {
      catalog_id: catalogId,
      brand_id: brandId ?? null,
      size_id: sizeId ?? null,
      upload_session_id: uploadSessionId,
      title: title || '',
      description: description || '',
      price: price ?? null
    }
  });
  const parsed = decodeResponse(r);
  return parsed?.package_size_id ?? null;
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
