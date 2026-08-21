/**
 * Single source of truth for the Vinted country domains the extension supports.
 *
 * Vinted runs one site per country (vinted.de, vinted.fr, …) on separate hostnames but
 * with an identical API surface. Several Chrome APIs need these as match-pattern arrays
 * (manifest host_permissions, webRequest filters, tabs.query). Centralising the list here
 * means adding a new market is a one-line change instead of editing three files.
 */
export const VINTED_HOSTS = [
  'vinted.com', 'vinted.de', 'vinted.fr', 'vinted.it', 'vinted.es',
  'vinted.nl', 'vinted.be', 'vinted.co.uk', 'vinted.pl', 'vinted.at',
  'vinted.cz', 'vinted.sk', 'vinted.lt', 'vinted.lu', 'vinted.pt',
  'vinted.ro', 'vinted.se', 'vinted.hu', 'vinted.dk', 'vinted.fi'
];

/**
 * Match patterns for chrome.tabs.query — matches ANY page on a Vinted domain.
 * `*.` covers the www subdomain (and any other), `/*` covers any path.
 */
export function tabMatchPatterns() {
  return VINTED_HOSTS.map(h => `https://*.${h}/*`);
}

/**
 * Der API-Host einer Marktplatz-Domain: `www.vinted.de` → `api.vinted.de`.
 *
 * Nicht jeder Vinted-Endpunkt liegt unter der Marktplatz-Domain. Der Versand-Dienst tut es
 * nicht: `https://www.vinted.de/shipping-estimation/…` antwortet mit der 404-HTML-Seite,
 * `https://api.vinted.de/shipping-estimation/…` mit `{"package_size_id":1}` (gemessen
 * 2026-08-21, und genau so ruft die SPA es auf `/items/new` selbst auf).
 *
 * Gemessen nur auf `.de`. Für die anderen Märkte ist das eine Ableitung — sie folgt aber
 * dem Muster, das Vinted überall verwendet, und ein falscher Host scheitert laut mit 404
 * statt still mit einem falschen Wert.
 */
export function apiHostFor(domain) {
  const host = String(domain || '').trim().toLowerCase();
  if (!host) return null;
  return `api.${host.replace(/^(www|api)\./, '')}`;
}

/**
 * Match patterns for chrome.webRequest — restricted to `/api/` so the token snooper
 * only inspects API calls, not every image/asset request (cheaper + less noisy).
 */
export function apiMatchPatterns() {
  return VINTED_HOSTS.map(h => `https://*.${h}/api/*`);
}

/**
 * True for any `vinted.<tld>` hostname. Intentionally broader than VINTED_HOSTS — it
 * accepts ccTLDs we don't explicitly list, so URL validation never rejects a legit
 * (but unlisted) Vinted domain the user happens to be on.
 */
/**
 * The language a marketplace expects, from its host.
 *
 * The draft's texts are written during preparation, when the target domain is not yet
 * fixed (KONZEPT §7.7) — so the language is a setting, and this is what it gets compared
 * against before anything is uploaded. A German description on `vinted.fr` is not
 * something that repairs itself comfortably after the fact.
 *
 * Returns null for a host we have no mapping for, which means "do not claim a mismatch".
 */
const HOST_LANGUAGES = {
  de: 'de', at: 'de', fr: 'fr', be: 'fr', lu: 'fr', it: 'it', es: 'es', nl: 'nl',
  pl: 'pl', cz: 'cs', sk: 'sk', lt: 'lt', pt: 'pt', ro: 'ro', se: 'sv', hu: 'hu',
  dk: 'da', fi: 'fi', com: 'en', net: 'en'
};

export function languageForHost(hostname) {
  const tld = String(hostname || '').toLowerCase().split('.').pop();
  if (tld === 'uk') return 'en'; // vinted.co.uk
  return HOST_LANGUAGES[tld] || null;
}

export function isVintedHost(hostname) {
  return /(^|\.)vinted\.[a-z.]+$/i.test(hostname || '');
}
