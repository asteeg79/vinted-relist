/**
 * The in-memory RelistPort adapter — the second adapter that makes the seam real.
 *
 * It records every call the pipeline makes, in order, so tests can assert the thing that
 * actually matters: that `deleteItem` is never reached when anything upstream failed.
 * Nothing here touches chrome.*, the network or the clock.
 *
 * Usage:
 *   const port = makeFakePort();                          // happy path
 *   const port = makeFakePort({ settings: { deleteEnabled: false } });
 *   const port = makeFakePort({ createItem: () => { throw new ApiError(400, body); } });
 *
 * Any member name passed in `opts` replaces that member's behaviour; the call is still
 * recorded first, so `port.names` stays a faithful trace either way.
 *
 * Signatures are declared in full (no defaults, no rest params) so the conformance test
 * in tests/relist-port.test.js can compare arity against lib/relist-port.js.
 */
import { DEFAULT_SETTINGS } from '../../lib/settings.js';

/** A realistic source item, shaped like GET /api/v2/item_upload/items/{id}. */
export const SOURCE_ITEM = {
  id: 111,
  title: 'Lego Technic 42100',
  description: 'Vollständig, mit OVP.',
  currency: 'EUR',
  price: 7,
  brand_id: 407093,
  brand: 'LEGO Technic',
  catalog_id: 1767,
  status_id: 2,
  size_id: 620,
  package_size_id: 2,
  color1_id: 17,
  color2_id: null,
  is_unisex: true,
  user_id: 4242,
  favourite_count: 3,
  view_count: 41,
  conversation_count: 1,
  photos: [
    { full_size_url: 'https://images1.vinted.net/a.jpg', high_resolution: { orientation: 0 } },
    { full_size_url: 'https://images1.vinted.net/b.jpg', high_resolution: { orientation: 1 } }
  ]
};

export const NEW_ITEM_ID = 999;
export const UPLOAD_SESSION_ID = 'session-uuid-1';
export const V_UID = '4242';

/**
 * Build a fake port.
 *
 * opts:
 *   settings   partial settings merged over DEFAULT_SETTINGS
 *   source     the item `fetchItem` returns for the ORIGINAL id (null → no photos case)
 *   vUid       the logged-in user id ensureAuth reports (drives the ownership gate)
 *   auth       partial auth bundle merged over the default
 *   counts     what relistCounts() returns
 *   confirmedDelete  the first-run flag (defaults to true — already acknowledged)
 *   <member>   a function replacing that port member's behaviour
 */
export function makeFakePort(opts = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(opts.settings || {}) };
  const source = 'source' in opts ? opts.source : structuredClone(SOURCE_ITEM);

  // Items the pipeline has created, keyed by id — so the verification fetch of a just-
  // created item resolves the way the real API eventually does.
  const created = new Map();

  const state = {
    /** Ordered trace of { name, args } — the one record; `names` derives from it. */
    calls: [],
    progress: [],   // [{ pct, label }]
    history: [],    // entries passed to recordRelist
    sleeps: [],     // ms values
    uploads: [],    // [{ filename, quality, tempUuid }]
    createPayloads: [], // every payload handed to createItem (clone-on-write)
    deleted: [],    // item ids passed to deleteItem
    settings,
    created
  };

  /** Count how many times a member was called. */
  state.countOf = name => state.calls.reduce((n, c) => n + (c.name === name), 0);
  /** Args of the nth (0-based) call to a member. */
  state.argsOf = (name, n = 0) => state.calls.filter(c => c.name === name)[n]?.args;

  function record(name, args) {
    state.calls.push({ name, args });
  }

  /** Run the caller's override for `name` if they gave one, else the default behaviour. */
  function behave(name, args, fallback) {
    record(name, args);
    const override = opts[name];
    return typeof override === 'function' ? override(...args) : fallback();
  }

  // Every member except the two synchronous ones (newUploadSessionId, version) is async,
  // matching the live adapter — so an override that throws surfaces as a rejection,
  // exactly as a failing HTTP call would.
  const port = {
    ensureAuth: async (domain, itemId) => behave('ensureAuth', [domain, itemId], () => ({
      csrf: 'csrf-1',
      anonId: 'anon-1',
      vUdt: 'udt-1',
      vUid: 'vUid' in opts ? opts.vUid : V_UID,
      ...(opts.auth || {})
    })),

    fetchItem: async (domain, auth, itemId) => behave('fetchItem', [domain, auth, itemId], () => {
      const key = String(itemId);
      if (created.has(key)) return created.get(key);
      if (!source) throw new Error(`fake-port: no source item configured for ${key}`);
      return { ...source, id: Number(itemId) || source.id };
    }),

    uploadPhoto: async (domain, auth, blob, filename, uploadOpts) =>
      behave('uploadPhoto', [domain, auth, blob, filename, uploadOpts], () => {
        const n = state.uploads.length;
        state.uploads.push({ filename, quality: blob?.quality, tempUuid: uploadOpts?.tempUuid });
        return { id: 1000 + n, temp_uuid: uploadOpts?.tempUuid ?? `tu-${n}` };
      }),

    createItem: async (domain, auth, payload, createOpts) =>
      behave('createItem', [domain, auth, payload, createOpts], () => {
        state.createPayloads.push(structuredClone(payload));
        // Mirror the real API: the new item becomes fetchable, carrying its photos.
        created.set(String(NEW_ITEM_ID), {
          id: NEW_ITEM_ID,
          title: payload.item.title,
          photos: payload.item.assigned_photos.map(p => ({ id: p.id, orientation: p.orientation }))
        });
        return { id: NEW_ITEM_ID };
      }),

    deleteItem: async (domain, auth, itemId) => behave('deleteItem', [domain, auth, itemId], () => {
      state.deleted.push(String(itemId));
    }),

    downloadPhoto: async (url) => behave('downloadPhoto', [url], () => ({ size: 1024, type: 'image/jpeg', url })),

    encodePhoto: async (blob, quality) => behave('encodePhoto', [blob, quality], () => ({
      size: 900, type: 'image/jpeg', quality, from: blob?.url
    })),

    getSettings: async () => behave('getSettings', [], () => settings),

    recordRelist: async (entry) => behave('recordRelist', [entry], () => { state.history.push(entry); }),

    relistCounts: async () => behave('relistCounts', [], () => opts.counts || { lastHour: 0, last24h: 0, total: 0 }),

    hasConfirmedDelete: async () => behave('hasConfirmedDelete', [], () => opts.confirmedDelete ?? true),

    sleep: async (ms) => behave('sleep', [ms], () => { state.sleeps.push(ms); }),

    newUploadSessionId: () => behave('newUploadSessionId', [], () => UPLOAD_SESSION_ID),

    version: () => behave('version', [], () => '0.0.0-test'),

    publishProgress: async (pct, label) => behave('publishProgress', [pct, label], () => { state.progress.push({ pct, label }); }),

    log: async (event, data) => behave('log', [event, data], () => {})
  };

  // The recorded state hangs off the port so a test only carries one object around.
  // `names` is a live getter rather than a copied array, since it derives from `calls`.
  Object.assign(port, state);
  Object.defineProperty(port, 'names', { get: () => state.calls.map(c => c.name) });
  return port;
}
