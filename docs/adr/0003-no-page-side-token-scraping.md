# ADR-0003 — Auth tokens come from the service worker only

**Status:** accepted · **Date:** 2026-08-12 (v0.37.0)

## Context

The content script sits inside an authenticated Vinted page, so it looks like the ideal
place to read auth tokens. It had a reporter that scraped a `<meta name="csrf-token">` tag
and the `XSRF-TOKEN` / `csrf_token` cookies, then messaged them to the service worker.

Vinted uses none of those. It is a Next.js app whose CSRF token lives in an inline script,
and whose session cookies are HttpOnly. The reporter therefore only ever sent `csrf: null`
— and `saveSession` merged that null over a good token, turning "nothing new to report"
into "forget what you had".

## Decision

Two sources, both in the service worker:

- **webRequest snooper** — captures `X-CSRF-Token` / `X-Anon-Id` off the SPA's own API
  calls. Always current.
- **`chrome.cookies`** — reads `anon_id`, `v_uid`, `v_udt`, including HttpOnly cookies,
  which a content script fundamentally cannot see.

An HTML scrape of an authenticated page is the last-resort fallback.

`saveSession` drops null and undefined fields so no caller can erase a stored token.

## Consequences

- The content script has one less responsibility, and every Vinted page stops running a
  MutationObserver, a focus listener and a 10×500ms poll.
- The `session/update` message type no longer exists.

## Do not re-suggest

"The content script could read the token from the page." It can, in principle — the token
is in an inline script — but the webRequest snooper already has it, fresher, without
parsing HTML. Adding a second writer to the same store is what caused the original bug.
