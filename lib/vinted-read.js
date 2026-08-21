/**
 * Der Lese-Transport für die Vorbereitung.
 *
 * WHY THIS EXISTS AND WHY IT IS ONLY FOR READS. ADR-0001 routes Vinted calls through the
 * content script, because a state-changing request from an extension origin is refused.
 * The 0b spike measured the read case separately (2026-08-14): a `GET` from an extension
 * page comes back `200` with JSON **as long as the usual headers go with it**, and `403`
 * with an HTML page without them. The origin was never the obstacle — the headers were.
 *
 * So the taxonomy lookups run straight from the studio and Stufe 2 needs no open Vinted
 * tab. Writing still crosses the content script: the create was NOT retested, and that is
 * exactly where the service-worker fetch failed in the first place.
 *
 * `ensureAuth` and `fetch` are injected so the tests exercise the whole path without a
 * network and without chrome.*.
 */
import { ApiError, AuthError, ValidationError } from './errors.js';

/**
 * The header set that made the difference in the spike.
 *
 * Mirrors what the SPA itself sends (see `page-api.js`) — matching it is both what makes
 * the call work and what keeps us indistinguishable from the real UI.
 */
export function readHeaders(auth, { json = false } = {}) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Enable-Multiple-Size-Groups': 'true',
    'X-Upload-Form': 'true'
  };
  if (json) headers['Content-Type'] = 'application/json';
  if (auth?.csrf) headers['X-CSRF-Token'] = auth.csrf;
  if (auth?.anonId) headers['X-Anon-Id'] = auth.anonId;
  return headers;
}

/**
 * Der Satz, der auf einen 401 gehört.
 *
 * DIE EINE STÖRUNG, DIE SICH SELBST BEHEBEN LÄSST. Vinteds Sitzungs-Cookie ist kurzlebig
 * und wird von der SPA nachgezogen, solange irgendwo ein Vinted-Tab offen ist. Ist keiner
 * offen, altert es weg — und dann antwortet jeder Lesezugriff aus dem Studio mit
 * `401 {"code":100,"message_code":"invalid_authentication_token"}`, obwohl der Nutzer
 * angemeldet ist und die Seite im Browser einwandfrei funktioniert. Gemessen am
 * 2026-08-21: um 08:12 mit offenem Tab alles 200, um 12:01 ohne Tab dreimal 401, nach dem
 * Öffnen von vinted.de sofort wieder 200.
 *
 * Deshalb ein eigener Fehlertyp mit einem Satz, der die Abhilfe nennt, statt
 * `HTTP 401: {"code":100,…}` — das ist die Zeile, die der Nutzer im Studio zu lesen bekommt.
 */
export const SESSION_EXPIRED =
  'Vinted-Sitzung abgelaufen. Kurz vinted.de in einem Tab öffnen — danach funktioniert das '
  + 'Nachschlagen wieder. (Angemeldet bist du weiterhin; nur das Sitzungs-Token ist alt.)';

/**
 * Build the `fetchJson(path, options)` that `lib/taxonomy.js` takes as its transport.
 *
 * Throws `AuthError` on a 401 and `ApiError` on every other non-2xx — a hole in the
 * taxonomy has to surface. A `200` that is not JSON is the anti-bot page rather than an
 * answer, and is refused just as loudly.
 */
export function createVintedFetch({ domain, ensureAuth, fetchImpl = globalThis.fetch } = {}) {
  return async function fetchJson(path, options = {}) {
    const auth = await ensureAuth(domain);
    const response = await fetchImpl(`https://${domain}${path}`, {
      method: options.method || 'GET',
      credentials: 'include',
      headers: { ...readHeaders(auth, { json: !!options.body }), ...(options.headers || {}) },
      body: options.body
    });

    const text = await response.text();
    if (response.status === 401) throw new AuthError(SESSION_EXPIRED);
    if (!response.ok) throw new ApiError(response.status, text);
    try {
      return JSON.parse(text);
    } catch {
      throw new ValidationError('Antwort von Vinted war kein JSON — vermutlich die Abwehrseite.');
    }
  };
}
