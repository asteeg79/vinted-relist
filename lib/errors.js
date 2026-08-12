/**
 * Typed error classes used across the extension.
 *
 * Why typed errors: the retry layer (retry.js) and the pipeline (relist.js) branch on
 * the *kind* of failure — e.g. a 429 is retried with backoff, a 401 is surfaced to the
 * user as "log in again", a validation error is shown verbatim. Using `instanceof`
 * checks against these classes keeps that branching readable and robust.
 */

/** Thrown when Vinted responds 401 — the user's session is missing or expired. */
export class AuthError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AuthError';
  }
}

/**
 * Generic non-2xx HTTP response from Vinted.
 * Keeps the numeric `status` (for retry decisions) and the raw `body`
 * (full, untruncated — useful for anti-bot detection and diagnostics),
 * while the human-readable `message` is truncated to stay log-friendly.
 */
export class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${typeof body === 'string' ? body.slice(0, 300) : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body; // full body retained even though message is truncated
  }
}

/** A 429 Too Many Requests. Subclasses ApiError so generic 4xx handling still applies. */
export class RateLimitError extends ApiError {
  constructor(body) {
    super(429, body);
    this.name = 'RateLimitError';
  }
}

/**
 * A transport failure while talking to the content script: the page's `fetch()` rejected
 * ("Failed to fetch"), or no reply came back. The request never reached Vinted's
 * application layer, so there is nothing to interpret — it is transient by nature and
 * retry.js backs off and tries again.
 *
 * Deliberately NOT used for "no Vinted tab open" or "auto-inject failed": those need the
 * user to do something before any retry could succeed, so they stay non-retryable and
 * surface immediately.
 */
export class NetworkError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'NetworkError';
  }
}

/**
 * A relist was requested while one was already running. Only one may run at a time: two
 * concurrent pipelines interleave writes to the single `progress` record, and they defeat
 * the cooldown pacing that exists to keep Vinted's anti-bot heuristics quiet.
 */
export class BusyError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BusyError';
  }
}

/** Client-side validation failure (bad URL, not a Vinted item, …) — never retried. */
export class ValidationError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ValidationError';
  }
}
