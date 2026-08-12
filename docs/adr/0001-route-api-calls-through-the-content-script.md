# ADR-0001 — Route every Vinted API call through a content script

**Status:** accepted · **Date:** 2026-05 (recorded 2026-08-12)

## Context

The service worker is the natural place to make HTTP calls: it owns the pipeline, it can
read HttpOnly cookies, and it has no DOM to get in the way. It is also the obvious thing
for a reviewer to propose, repeatedly.

It does not work. Vinted rejects state-changing requests whose `Origin` is not a real
`vinted.*` page — a CSRF defence. A `fetch()` from the service worker carries
`Origin: chrome-extension://…` and gets **403**.

## Decision

The service worker packages each request as an `api/call` message and sends it to the
content script running in a Vinted tab. The content script performs the actual `fetch()`,
which then carries the correct same-origin `Origin` and the user's cookies.

`lib/page-api.js` is the service-worker half; `content/page-call.js` is the page half.

## Consequences

- A Vinted tab must be open. "No Vinted tab open" is a first-class, non-retryable error.
- Binary bodies cannot cross `chrome.tabs.sendMessage`, which serialises to JSON — photos
  are base64-encoded for transport and decoded page-side. Hence `blob_b64` parts.
- The seam adds a hop to every call and a message shape that must be kept in step on both
  sides. `tests/page-call.test.js` covers the round trip.

## Do not re-suggest

"Just fetch from the service worker." It returns 403. If you want to re-open this, the
only thing that would change the answer is Vinted dropping the Origin check — verify that
against the live API first.
