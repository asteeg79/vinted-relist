/**
 * The DraftPort — the seam the publish pipeline runs on.
 *
 * Same shape and same reasoning as `relist-port.js`: every effect the pipeline performs
 * goes through one object, so the safety logic can be exercised against an in-memory
 * adapter. The rule that matters here — a draft with an open field never reaches
 * `createItem` — is only testable because of this seam.
 *
 * TWO ADAPTERS JUSTIFY IT:
 *   - lib/live-draft-port.js          page-api + chrome storage (the browser)
 *   - tests/helpers/fake-draft-port.js  in-memory, records every call (the tests)
 *
 * PURE TRANSFORMS ARE NOT ON THE PORT. `buildNewItemPayload`, `draftView`, `crossCheck`
 * and `languageForHost` stay direct imports in draft.js — they touch nothing and are
 * already unit-tested; putting them here would widen the interface for no leverage.
 *
 * ADAPTER RULE: declare every parameter explicitly — no defaults, no rest params.
 * `missingMembers` compares Function.length against the arity below, and a default
 * silently shrinks that number.
 */

/** Member name → number of declared parameters. This list IS the interface. */
export const DRAFT_PORT_MEMBERS = {
  // --- auth -------------------------------------------------------------------------
  ensureAuth: 1,          // (domain) → { csrf, anonId, vUdt, vUid }

  // --- Vinted API (all writing, or reads that only exist after the upload) -----------
  uploadPhoto: 5,         // (domain, auth, blob, filename, opts) → { id, temp_uuid, high_resolution }
  suggestCategories: 3,   // (domain, auth, { imageMetadata, uploadSessionId }) → [catalogId, …]
  suggestAttributes: 3,   // (domain, auth, { imageMetadata, uploadSessionId, categoryId }) → { brands, colors, sizes }
  categoryAttributes: 3,  // (domain, auth, catalogId) → [{ code, … }] — what this category demands
  // Two params, not three: the shipping service refuses the CSRF headers (see page-api.js),
  // so there is no auth bundle to hand it.
  suggestPackageSize: 2,  // (domain, { catalogId, brandId, sizeId, uploadSessionId, title, description, price }) → id|null
  createItem: 4,          // (domain, auth, payload, opts) → new item (with id)

  // --- photos -----------------------------------------------------------------------
  decodePhoto: 2,         // (base64, mediaType) → blob

  // --- taxonomy -----------------------------------------------------------------------
  // Vinted's category suggestion returns bare ids; labelling them needs the cached tree,
  // and shipping 2910 entries across the message boundary per publish would be absurd.
  lookupCatalogs: 1,      // (ids) → [{ id, title, path }]

  // --- stored state -----------------------------------------------------------------
  getSettings: 0,         // () → settings
  recordDraft: 1,         // (entry) → void
  hasConfirmedCreate: 0,  // () → boolean (drives the first-run gate for a live create)

  // --- ambient ----------------------------------------------------------------------
  sleep: 1,               // (ms) → void
  newUploadSessionId: 0,  // () → uuid string      see SYNC_MEMBERS
  version: 0,             // () → version string   see SYNC_MEMBERS

  // --- reporting --------------------------------------------------------------------
  publishProgress: 2,     // (pct, label) → void
  log: 2                  // (event, data) → void
};

/** Members whose result the pipeline uses without awaiting. */
export const SYNC_MEMBERS = ['newUploadSessionId', 'version'];

/**
 * Check an object against the interface. Returns human-readable complaints — empty means
 * a valid adapter. The conformance test keeps the live and fake adapters in step; a
 * missing or re-signatured member is otherwise a failure that only shows in the browser.
 */
export function missingMembers(port) {
  const problems = [];
  if (!port || typeof port !== 'object') return ['port is not an object'];
  for (const [name, arity] of Object.entries(DRAFT_PORT_MEMBERS)) {
    const member = port[name];
    if (typeof member !== 'function') {
      problems.push(`${name}: missing (expected a function, got ${typeof member})`);
    } else if (member.length !== arity) {
      problems.push(`${name}: declares ${member.length} params, interface says ${arity} (no defaults/rest params in adapters)`);
    }
  }
  return problems;
}
