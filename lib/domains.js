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
export function isVintedHost(hostname) {
  return /(^|\.)vinted\.[a-z.]+$/i.test(hostname || '');
}
