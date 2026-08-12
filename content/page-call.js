/**
 * The page-side half of the `api/call` seam.
 *
 * lib/page-api.js packages each Vinted request as a message; this turns that message back
 * into arguments for `fetch()`. The two halves are the real interface between the service
 * worker and the page, and it used to be declared nowhere — the encoding lived in
 * lib/util.js, the decoding was inline in content.js, and nothing tested the round trip.
 * A change to the multipart encoding could only be verified by relisting a real item and
 * watching for a 400.
 *
 * THE MESSAGE (`api/call`):
 *   { method, path, headers, json?, multipart? }
 *   multipart entries are one of:
 *     { name, kind: 'text',     value }
 *     { name, kind: 'blob',     data, contentType, filename }          raw bytes
 *     { name, kind: 'blob_b64', data, contentType, filename, expectedSize }
 *   `blob_b64` exists because chrome.tabs.sendMessage serialises to JSON and cannot carry
 *   a Blob; util.js base64-encodes it and this decodes it back.
 *
 * WHY NO IMPORTS: a content script declared in the manifest is loaded as a classic script,
 * so `import`/`export` is a syntax error. Having none also makes this file loadable as an
 * ES module, which is how the tests get at it — they import it for the side effect and
 * then read globalThis.VintedPageCall. scripts/validate.mjs enforces the no-import rule.
 */
(function (root) {
  /** Decode a base64 string into a Uint8Array. */
  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * Turn one `api/call` message into `{ init, warnings }`.
   *
   * `warnings` carries anything the caller must know about but that isn't fatal here —
   * currently only a blob whose decoded size doesn't match what was sent. That used to be
   * a console.warn in the page, where the service worker could never see it; it now
   * travels back so the SW can treat a corrupted body as a failed request rather than
   * uploading a truncated photo.
   */
  function buildInit(msg) {
    const warnings = [];
    const init = {
      method: msg.method || 'GET',
      credentials: 'include', // send the user's session cookies
      headers: { ...(msg.headers || {}) } // copied: multipart deletes a header below
    };

    if (msg.json !== undefined) {
      init.body = JSON.stringify(msg.json);
      return { init, warnings };
    }

    if (!msg.multipart) return { init, warnings };

    const form = new FormData();
    for (const part of msg.multipart) {
      if (part.kind === 'blob' || part.kind === 'blob_b64') {
        const bytes = part.kind === 'blob_b64' ? base64ToBytes(part.data) : part.data;
        const blob = new Blob([bytes], { type: part.contentType || 'application/octet-stream' });
        if (part.expectedSize !== undefined && blob.size !== part.expectedSize) {
          warnings.push(`${part.name}: ${blob.size} bytes after decode, expected ${part.expectedSize}`);
        }
        form.append(part.name, blob, part.filename);
      } else {
        form.append(part.name, part.value); // plain text field
      }
    }
    init.body = form;
    // Must NOT set Content-Type for multipart — the browser adds the boundary itself.
    delete init.headers['Content-Type'];
    return { init, warnings };
  }

  root.VintedPageCall = { buildInit };
})(typeof globalThis === 'undefined' ? self : globalThis);
