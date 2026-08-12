import { ApiError, RateLimitError, NetworkError } from './errors.js';
import { sleep as realSleep } from './util.js';

/**
 * Retry wrapper for transient Vinted failures.
 *
 * Retry policy (by error type):
 *  - RateLimitError (429): exponential backoff 2s, 5s, 12.5s … (2000 · 2.5^i).
 *  - ApiError with 5xx status: a flat 3s wait (server hiccup, give it a moment).
 *  - NetworkError (page-side fetch failed, no reply): 1.5s, 3s, 6s — the request never
 *    reached Vinted, so there is nothing to interpret and a retry is worth having.
 *  - Anything else (4xx, validation, auth, no-tab-open): rethrow immediately.
 *
 * After `tries` attempts the last error is rethrown so the caller can surface it.
 *
 * `sleep` is injectable so the backoff can be driven by the caller's clock: the relist
 * pipeline passes its port's sleep, which means a test's fake makes the whole backoff
 * schedule instant while still recording the delays that were asked for.
 */
export async function withRetry(fn, { tries = 3, sleep = realSleep } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e instanceof RateLimitError) {
        await sleep(2000 * Math.pow(2.5, i));
      } else if (e instanceof ApiError && e.status >= 500) {
        await sleep(3000);
      } else if (e instanceof NetworkError) {
        // The request never reached Vinted — a blip mid-pipeline used to abort a run that
        // had already spent ~20s uploading photos. Ride it out.
        await sleep(1500 * Math.pow(2, i));
      } else {
        throw e; // non-retryable
      }
    }
  }
  throw lastErr;
}
