/**
 * Small, dependency-free, pure-ish utilities shared across modules.
 * Kept separate so the rest of the code never re-implements timing/UUID/base64 helpers.
 */

/** Promise that resolves after `ms` milliseconds. */
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Random delay in the half-open interval [min, max).
 * Used between API calls so the request timing isn't robotically even — evenly-spaced
 * calls are a classic bot signal that Vinted's anti-bot (Datadome) looks for.
 */
export const jitter = (min, max) => min + Math.random() * (max - min);

/**
 * RFC-4122 v4 UUID. Prefers the native crypto.randomUUID when available; the manual
 * fallback assembles one from 16 random bytes for the rare environment that lacks it.
 */
export function uuidV4() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  // Set the version (4) and variant (10xx) bits per the spec.
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

/**
 * Encode an ArrayBuffer to a base64 string.
 *
 * Why chunked: `String.fromCharCode(...hugeArray)` blows the call-stack for large
 * images (the photo blobs are hundreds of KB). We therefore convert at most 32 KB of
 * bytes per call and concatenate. The base64 string is what we ship to the content
 * script (chrome.tabs.sendMessage can't reliably transfer binary Blobs), where it's
 * decoded back into a Blob for the multipart upload.
 */
export function arrayBufferToBase64(buf) {
  const u8 = new Uint8Array(buf);
  const CHUNK = 0x8000; // 32 KB
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
  }
  return btoa(binary);
}
