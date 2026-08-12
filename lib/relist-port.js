/**
 * The RelistPort — the seam the relist pipeline runs on.
 *
 * lib/relist.js used to import page-api, image-utils, auth, settings, history, progress
 * and logger directly, which meant it created its own dependencies and no test could
 * stand between it and chrome.*. Every effect the pipeline performs now goes through a
 * single object satisfying this interface, so the 277 lines of safety logic (create-then-
 * delete ordering, the verify gate, the ownership gate, the colour auto-retry) are
 * exercisable through one interface.
 *
 * Two adapters justify the seam:
 *   - lib/live-port.js        page-api + image-utils + chrome storage (the browser)
 *   - tests/helpers/fake-port.js   in-memory, records every call (the tests)
 *
 * PURE TRANSFORMS ARE NOT ON THE PORT. parseUrl, buildItemUploadPayload, extractInterest,
 * pickPhotoUrl, photoOrientation and parseValidationErrors stay direct imports in
 * relist.js — they touch nothing, are already unit-tested, and putting them here would
 * widen the interface for no leverage.
 *
 * ADAPTER RULE: declare every parameter explicitly — no default values and no rest
 * params in an adapter's member signatures. `missingMembers` compares Function.length
 * against ARITY below to catch an adapter drifting out of step, and defaults/rest params
 * silently shrink that number.
 */

/** Member name → number of declared parameters. This list IS the interface. */
export const PORT_MEMBERS = {
  // --- auth -------------------------------------------------------------------------
  ensureAuth: 2,          // (domain, itemId) → { csrf, anonId, vUdt, vUid }

  // --- Vinted API -------------------------------------------------------------------
  fetchItem: 3,           // (domain, auth, itemId) → source item
  uploadPhoto: 5,         // (domain, auth, blob, filename, opts) → { id, temp_uuid }
  createItem: 4,          // (domain, auth, payload, opts) → new item (with id)
  deleteItem: 3,          // (domain, auth, itemId) → void

  // --- photos -----------------------------------------------------------------------
  downloadPhoto: 1,       // (url) → blob
  encodePhoto: 2,         // (blob, quality) → blob

  // --- stored state -----------------------------------------------------------------
  getSettings: 0,         // () → settings
  recordRelist: 1,        // (entry) → void
  relistCounts: 0,        // () → { lastHour, last24h, total }
  hasConfirmedDelete: 0,  // () → boolean (drives the first-run gate)

  // --- ambient ----------------------------------------------------------------------
  sleep: 1,               // (ms) → void
  newUploadSessionId: 0,  // () → uuid string      see SYNC_MEMBERS
  version: 0,             // () → version string   see SYNC_MEMBERS

  // --- reporting --------------------------------------------------------------------
  publishProgress: 2,     // (pct, label) → void
  log: 2                  // (event, data) → void
};

/**
 * Members whose result the pipeline uses directly, without awaiting. Adapters must keep
 * these synchronous; every other member returns a promise.
 */
export const SYNC_MEMBERS = ['newUploadSessionId', 'version'];

/**
 * Check an object against the interface. Returns a list of human-readable complaints —
 * empty means the object is a valid adapter. Used by the conformance test to keep the
 * live and fake adapters in step; a missing or re-signatured member is the failure mode
 * that would otherwise only show up in the browser.
 */
export function missingMembers(port) {
  const problems = [];
  if (!port || typeof port !== 'object') return ['port is not an object'];
  for (const [name, arity] of Object.entries(PORT_MEMBERS)) {
    const member = port[name];
    if (typeof member !== 'function') {
      problems.push(`${name}: missing (expected a function, got ${typeof member})`);
    } else if (member.length !== arity) {
      problems.push(`${name}: declares ${member.length} params, interface says ${arity} (no defaults/rest params in adapters)`);
    }
  }
  return problems;
}
