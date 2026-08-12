/**
 * Photo helpers: download a source image and re-encode it.
 *
 * Re-encoding matters for two reasons:
 *  1. Vinted hashes uploaded images for duplicate detection; an identical re-upload can
 *     be flagged or silently shadow-banned. A fresh JPEG with slightly varied quality
 *     produces different bytes/hash.
 *  2. Canvas re-encoding strips EXIF metadata (location, device) as a side benefit.
 *
 * Runs in the service worker, which is why it uses OffscreenCanvas (no DOM there).
 */

/**
 * Fetch an image URL into a Blob.
 * `credentials: 'omit'` — the Vinted CDN images are public; sending cookies can trip
 * CORS and isn't needed.
 */
export async function fetchAsBlob(url) {
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw new Error('Photo fetch failed: ' + r.status);
  return r.blob();
}

/**
 * Re-encode a blob to JPEG at (approximately) the given quality.
 * A small random ±0.02 jitter is added to the quality so two reposts of the very same
 * source image don't come out byte-identical (defeats hash-based duplicate detection),
 * clamped to a sane [0.6, 0.98] range.
 */
export async function reencode(blob, quality = 0.92) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.(); // free the decoded image promptly
  const q = quality + (Math.random() * 0.04 - 0.02);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: Math.max(0.6, Math.min(0.98, q)) });
}
