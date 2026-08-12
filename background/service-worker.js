/**
 * Background service worker — the extension's central coordinator.
 *
 * It is deliberately THIN: it owns no business logic, only
 *   (1) a passive webRequest listener that snoops CSRF + anon-id tokens off the SPA's
 *       own API calls, and
 *   (2) a message router that dispatches popup / content-script requests to lib/*.
 *
 * Message protocol (chrome.runtime.onMessage):
 *   relist/preflight  {url}                               → non-destructive check; returns
 *                                                           interest + counts + the ordered `gates`
 *                                                           the UI must walk the user through
 *   relist/run        {url}                               → full create-then-delete pipeline;
 *                                                           replies with a `message` describing
 *                                                           the outcome for the UI to render
 *   relist/confirmed  {}                                  → remember the first-run acknowledgement
 *
 * All handlers reply asynchronously, so each returns `true` to keep the message channel
 * open until sendResponse is called.
 *
 * Both UIs render the `gates` and `message` this router hands them rather than deciding
 * for themselves — see lib/gates.js for why.
 */
import { relist, preflight } from '../lib/relist.js';
import { saveLiveTokens, extractTokensFromHeaders } from '../lib/auth.js';
import { clearProgress } from '../lib/progress.js';
import { apiMatchPatterns } from '../lib/domains.js';
import { describeOutcome, describeFailure } from '../lib/gates.js';
import { setConfirmedDelete } from '../lib/confirmation.js';

// --- Passive token snooper ---------------------------------------------------------
// Every time the Vinted SPA makes an API call, capture its X-CSRF-Token / X-Anon-Id so
// ensureAuth() can reuse the freshest tokens without scraping HTML. `extraHeaders` is
// required for Chrome to expose these custom request headers to the listener.
try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        const { csrf, anonId } = extractTokensFromHeaders(details.requestHeaders || []);
        if (csrf || anonId) {
          // Fire-and-forget; a storage write failure here must never block the request.
          saveLiveTokens(new URL(details.url).hostname, { csrf, anonId }).catch(() => {});
        }
      } catch {}
    },
    { urls: apiMatchPatterns() },
    ['requestHeaders', 'extraHeaders']
  );
} catch {
  // webRequest permission missing → ensureAuth() falls back to cookies + HTML scraping.
}

// --- Message router ----------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'relist/preflight':
      preflight(msg.url)
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(err => sendResponse({ ok: false, error: err.message, name: err.name }));
      return true;

    case 'relist/run':
      relist(msg.url)
        .then(result => {
          // Leave the 100% bar visible for a moment before clearing it.
          setTimeout(() => clearProgress(), 2500);
          sendResponse({ ok: true, ...result, message: describeOutcome(result) });
        })
        .catch(async err => {
          await clearProgress(); // hide the bar immediately on failure
          sendResponse({ ok: false, error: err.message, name: err.name, message: describeFailure(err) });
        });
      return true;

    case 'relist/confirmed':
      setConfirmedDelete()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
  }
});
