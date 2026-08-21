/**
 * The in-memory DraftPort adapter — the second adapter that makes the seam real.
 *
 * It records every call the publish pipeline makes, in order, so a test can assert the
 * thing that actually matters: that `createItem` is never reached when the draft was not
 * ready. Nothing here touches chrome.*, the network or the clock.
 *
 * Usage:
 *   const port = makeFakeDraftPort();
 *   const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
 *   const port = makeFakeDraftPort({ createItem: () => { throw new ApiError(400, body); } });
 *
 * Any member name passed in `opts` replaces that member's behaviour; the call is still
 * recorded first, so `port.names` stays a faithful trace either way.
 *
 * Signatures are declared in full (no defaults, no rest params) so the conformance test
 * can compare arity against lib/draft-port.js.
 */
import { DEFAULT_SETTINGS } from '../../lib/settings.js';

/** A draft as the studio hands it over, with every field resolved and confirmed. */
export const READY_DRAFT = {
  analysis: {
    brand: 'Nike',
    brand_confidence: 0.95,
    type: 'Hoodies & Sweaters',
    type_confidence: 0.97,
    size_label: 'M',
    size_source: 'label_photo',
    category_group: 'clothing',
    colors: ['Schwarz'],
    material: 'Baumwolle',
    description_sentence: 'Ein schlichter Hoodie.',
    description_facts: [{ label: 'Material', value: 'Baumwolle' }],
    photo_order: [
      { index: 0, role: 'Vorderseite', cropped_off: false },
      { index: 1, role: 'Etikett', cropped_off: false }
    ],
    notes: []
  },
  resolved: {
    catalog: { id: 196, label: 'Hoodies & Sweaters', confidence: 1, candidates: [] },
    brand: { id: 53, label: 'Nike', confidence: 1, candidates: [] },
    color: { id: 1, label: 'Schwarz', confidence: 1, candidates: [] },
    size: { id: 105, label: 'M / 38 / 10', confidence: 1, candidates: [] }
  },
  price: { value: 18, source: 'range' },
  condition: 2,
  confirmations: { condition: true },
  photos: [{ touchesEdge: false, judged: true }, { touchesEdge: false, judged: true }]
  // Keine `packageSizeId`: die Sendungsgröße kommt aus Vinteds eigenem Vorschlag und
  // braucht die upload_session_id, existiert also erst mitten in der Pipeline.
};

export const PHOTOS = [
  { base64: 'AAAA', mediaType: 'image/jpeg', filename: 'a.jpg' },
  { base64: 'BBBB', mediaType: 'image/jpeg', filename: 'b.jpg' }
];

export function makeFakeDraftPort(opts = {}) {
  const calls = [];
  const settings = { ...DEFAULT_SETTINGS, ...(opts.settings || {}) };
  let photoId = 1000;

  /**
   * Record the call, then run the override if one was supplied.
   *
   * Each member below still declares its parameters in full — `missingMembers` compares
   * `Function.length`, and a rest param would silently report arity 0.
   */
  const rec = (name, args, fallback) => {
    calls.push({ name, args });
    return opts[name] ? opts[name](...args) : fallback();
  };

  const port = {
    ensureAuth: (domain) =>
      rec('ensureAuth', [domain], () => ({ csrf: 'csrf', anonId: 'anon', vUdt: null, vUid: '42' })),

    uploadPhoto: (domain, auth, blob, filename, opt) =>
      rec('uploadPhoto', [domain, auth, blob, filename, opt], () => ({
        id: ++photoId,
        temp_uuid: opt?.tempUuid,
        high_resolution: { id: `img_${photoId}` }
      })),
    suggestCategories: (domain, auth, opt) => rec('suggestCategories', [domain, auth, opt], () => [196]),
    suggestAttributes: (domain, auth, opt) => rec('suggestAttributes', [domain, auth, opt], () => ({
      brands: [{ id: 53, title: 'Nike' }],
      colors: [{ id: 1, title: 'Schwarz' }],
      sizes: []
    })),
    categoryAttributes: (domain, auth, catalogId) => rec('categoryAttributes', [domain, auth, catalogId], () => []),
    suggestPackageSize: (domain, opt) => rec('suggestPackageSize', [domain, opt], () => 2),
    createItem: (domain, auth, payload, opt) =>
      rec('createItem', [domain, auth, payload, opt], () => ({ id: 555001 })),

    decodePhoto: (base64, mediaType) => rec('decodePhoto', [base64, mediaType], () => ({ size: base64.length })),

    lookupCatalogs: (ids) => rec('lookupCatalogs', [ids], () =>
      ids.map(id => ({ id, title: 'Kat ' + id, path: 'Damen > Kleidung > Kat ' + id }))),

    getSettings: () => rec('getSettings', [], () => settings),
    recordDraft: (entry) => rec('recordDraft', [entry], () => {}),
    hasConfirmedCreate: () => rec('hasConfirmedCreate', [], () => true),

    sleep: (ms) => rec('sleep', [ms], () => {}),
    newUploadSessionId: () => rec('newUploadSessionId', [], () => 'sess-fixed'),
    version: () => rec('version', [], () => '0.0.0-test'),

    publishProgress: (pct, label) => rec('publishProgress', [pct, label], () => {}),
    log: (event, data) => rec('log', [event, data], () => {})
  };

  port.calls = calls;
  Object.defineProperty(port, 'names', { get: () => calls.map(c => c.name) });
  /** Every argument list for one member, in call order. */
  port.argsFor = name => calls.filter(c => c.name === name).map(c => c.args);
  port.called = name => calls.some(c => c.name === name);
  return port;
}
