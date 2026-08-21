import { ValidationError } from './errors.js';
import { isVintedHost } from './domains.js';

/**
 * Pure item-data transforms: URL parsing, building the create payload, and reading
 * fields off a source item. No chrome.* / no I/O — fully unit-testable.
 */

/**
 * Parse a Vinted item URL into { domain, itemId }.
 * Accepts both slugged (`/items/123-blue-jacket`) and bare (`/items/123`) forms.
 * Throws ValidationError for non-Vinted hosts or non-item paths.
 */
export function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new ValidationError('Invalid URL.'); }
  if (!isVintedHost(u.hostname)) throw new ValidationError('Not a Vinted URL.');
  const m = u.pathname.match(/\/items\/(\d+)/); // leading numeric id, slug ignored
  if (!m) throw new ValidationError('Not a Vinted item URL.');
  return { domain: u.hostname, itemId: m[1] };
}

/**
 * Build the body for POST /api/v2/item_upload/items.
 *
 * Inputs:
 *  - `src`            the source item, as returned by GET /api/v2/item_upload/items/{id}
 *  - `uploadedPhotos` the freshly uploaded photos, each { id, temp_uuid, orientation }
 *  - `explicitSessionId` the shared upload-session UUID (preferred); falls back to the
 *                     first photo's temp_uuid.
 *
 * Field shape was reverse-engineered from a real "edit & save" request (see
 * project memory). Key non-obvious bits:
 *  - `assigned_photos` are OBJECTS `{id, orientation}` (integer ids), not UUID strings.
 *  - `status_id` carries the item condition.
 *  - `temp_uuid` and top-level `upload_session_id` must be the SAME value — Vinted ties
 *    the uploaded photos to that session id; a mismatch is rejected at create time.
 */
export function buildItemUploadPayload(src, uploadedPhotos, explicitSessionId) {
  const uploadSessionId = explicitSessionId || uploadedPhotos[0]?.temp_uuid;
  if (!uploadSessionId) throw new Error('At least one uploaded photo or explicit session id is required.');
  const assignedPhotos = uploadedPhotos.map(p => ({ id: p.id, orientation: p.orientation ?? 0 }));
  const colorIds = [src.color1_id, src.color2_id].filter(Boolean); // drop null/0 colours

  return {
    item: {
      currency: src.currency || 'EUR',
      temp_uuid: uploadSessionId,
      title: src.title,
      description: src.description || '',
      brand_id: src.brand_id ?? null,
      brand: src.brand ?? null,
      catalog_id: src.catalog_id,
      isbn: src.isbn ?? null,
      is_unisex: !!src.is_unisex,
      ai_photo: false,
      // Source price may arrive as a number or as { amount, currency_code }.
      price: typeof src.price === 'object' ? parseFloat(src.price.amount) : parseFloat(src.price),
      package_size_id: src.package_size_id ?? null,
      shipment_prices: { domestic: null, international: null },
      color_ids: colorIds,
      color1_id: src.color1_id ?? null,
      color2_id: src.color2_id ?? null,
      assigned_photos: assignedPhotos,
      measurement_length: src.measurement_length ?? null,
      measurement_width: src.measurement_width ?? null,
      measurement_unit: src.measurement_unit ?? null, // the measurements above are meaningless without it
      // Category-specific fields the source may carry. A relist is a faithful replay of
      // the user's own listing, so anything the item had is sent back; absent fields go as
      // null, exactly like isbn and manufacturer already do. Dropping these silently lost
      // the author and title of every book/comic that was relisted.
      author: src.author ?? null,
      book_title: src.book_title ?? null,
      model: src.model ?? null,
      ontology_collection_id: src.ontology_collection_id ?? null,
      ontology_model_id: src.ontology_model_id ?? null,
      video_game_rating_id: src.video_game_rating_id ?? null,
      status_id: conditionId(src),
      size_id: sizeId(src),
      // Per-category attributes — condition, book language, material, … — live in this
      // bag, and which ones a category demands changes over time. Replay it verbatim:
      // it is the user's own data, and dropping it silently loses every field Vinted
      // keeps there. Observed 2026-08-12: a comics listing was rejected with
      // `language_book` because the language the user had set was never sent back.
      item_attributes: Array.isArray(src.item_attributes) ? src.item_attributes : [],
      manufacturer: src.manufacturer ?? null,
      manufacturer_labelling: src.manufacturer_labelling ?? null
    },
    feedback_id: null,
    push_up: false,
    parcel: null,
    upload_session_id: uploadSessionId
  };
}

/**
 * Build the body for POST /api/v2/item_upload/items for a NEW article.
 *
 * A SECOND BUILDER, NOT A REUSE (ADR-0007, Entscheidung 2). It would have been possible
 * to assemble a synthetic `src` and push it through `buildItemUploadPayload` — and it
 * would have been a trap. ADR-0004 records that Vinted changes the shape of the READ
 * response without warning, and on 2026-08-12 exactly that happened. A single builder
 * makes a change to reading break creating too. The pure helpers below (`conditionId`,
 * `sizeId`, the attribute bag) are shared; the payload assembly is not.
 *
 * WHAT IS DIFFERENT FROM A RELIST, and why:
 *  - `orientation` is always 0. The canvas has physically uprighted the pixels
 *    (`imageOrientation: 'from-image'`), so passing an EXIF value through would rotate
 *    the photo a second time. `photoOrientation()` must NOT be used here (KONZEPT §5.5).
 *  - There is no source item to replay, so the per-category bag stays empty and the
 *    media/measurement fields go as null rather than being invented.
 *
 * NOTHING IS DEFAULTED. A missing title, category, condition or price throws instead of
 * travelling as `undefined` — condition and size especially, see ADR-0005: guessing them
 * misdescribes the goods. `draft-view.js` will not release publishing with an open field,
 * so a throw here means a bug upstream, and it should be loud.
 */
export function buildNewItemPayload(draft = {}, uploadedPhotos = [], explicitSessionId) {
  const uploadSessionId = explicitSessionId || uploadedPhotos[0]?.temp_uuid;
  if (!uploadSessionId) throw new ValidationError('Keine Upload-Session — mindestens ein hochgeladenes Foto oder eine Session-Id.');
  if (!uploadedPhotos.length) throw new ValidationError('Ein Inserat ohne Foto gibt es nicht.');

  const required = { title: draft.title, catalog_id: draft.catalogId, status_id: draft.statusId, price: draft.price };
  for (const [field, value] of Object.entries(required)) {
    if (value == null || value === '') throw new ValidationError(`Pflichtfeld fehlt: ${field}`);
  }

  const price = typeof draft.price === 'number' ? draft.price : parseFloat(draft.price);
  if (!Number.isFinite(price) || price <= 0) throw new ValidationError('Pflichtfeld fehlt: price');

  const colorIds = (draft.colorIds || []).filter(Boolean);

  return {
    item: {
      currency: draft.currency || 'EUR',
      temp_uuid: uploadSessionId,
      title: draft.title,
      description: draft.description || '',
      brand_id: draft.brandId ?? null,
      brand: draft.brand ?? null,
      catalog_id: draft.catalogId,
      isbn: draft.isbn ?? null,
      is_unisex: !!draft.isUnisex,
      // Same as the relist path: we are not using Vinted's own photo-recognition flow.
      ai_photo: false,
      price,
      package_size_id: draft.packageSizeId ?? null,
      shipment_prices: { domestic: null, international: null },
      color_ids: colorIds,
      color1_id: colorIds[0] ?? null,
      color2_id: colorIds[1] ?? null,
      // Orientation 0, always — see the note above.
      assigned_photos: uploadedPhotos.map(p => ({ id: p.id, orientation: 0 })),
      measurement_length: null,
      measurement_width: null,
      measurement_unit: null,
      status_id: draft.statusId,
      size_id: draft.sizeId ?? null,
      // No source item to replay from. Which attributes a category demands is asked at
      // runtime (`fetchCategoryAttributesViaPage`) and checked BEFORE the upload — see
      // `unfillableAttributeCodes` below. Anything Vinted still misses comes back as a
      // validation error we surface verbatim rather than pre-empt with a guess.
      item_attributes: draft.itemAttributes || []
    },
    feedback_id: null,
    push_up: false,
    parcel: null,
    upload_session_id: uploadSessionId
  };
}

/**
 * Attribut-Codes, die Vinted für eine Kategorie führt und die wir NICHT liefern können.
 *
 * Der Relist-Pfad spielt `item_attributes` aus dem Vorgänger-Artikel zurück; im
 * Auto-Listing gibt es keinen Vorgänger, und ein Attributwert lässt sich nicht erraten
 * (ADR-0005 — die falsche Sprache oder die falsche Plattform steht danach öffentlich im
 * Inserat). Was hier übrig bleibt, ist deshalb kein Feld, das wir noch füllen könnten,
 * sondern der Grund, den Draft VOR dem Upload anzuhalten.
 *
 * `COVERED` sind die Codes, für die es an anderer Stelle in der Payload eine eigene Spalte
 * gibt — taucht einer davon im Attributbeutel auf, ist er längst beantwortet.
 *
 * Gemessen 2026-08-21: für jede geprüfte Kategorie (Kleidung, Schuhe, Bücher, Spielzeug)
 * ist die Attributliste leer. Dies ist ein Fangnetz, kein Regelweg.
 */
const COVERED = new Set([
  'category', 'catalog', 'brand', 'size', 'color', 'colour', 'condition', 'status',
  'isbn', 'author', 'book_title', 'package_size', 'price'
]);

export function unfillableAttributeCodes(attributes = []) {
  const codes = [];
  for (const attribute of Array.isArray(attributes) ? attributes : []) {
    const code = String(attribute?.code ?? '').trim();
    if (!code || COVERED.has(code.toLowerCase())) continue;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * The item's condition ("Zustand") id.
 *
 * Vinted has shipped this under more than one name. `status_id` was returned by
 * GET /api/v2/item_upload/items/{id} until at least 2026-07-11 and then stopped appearing
 * (observed 2026-08-12: the response omits it, the create call then has no condition and
 * is rejected with `condition: Wähle ein Zustand`). Each known shape is tried in turn,
 * the same way pickPhotoUrl copes with the varying photo shapes.
 *
 * Returns null when none is present — the caller must NOT invent one. Condition is
 * shown to buyers, so guessing it would misdescribe the goods.
 */
export function conditionId(src) {
  return src.status_id
    ?? src.condition_id
    ?? src.status?.id
    ?? src.condition?.id
    ?? (typeof src.status === 'number' ? src.status : null)
    ?? attributeId(src, ['status', 'condition'])
    ?? null;
}

/**
 * Look up an id inside `item_attributes` — the generic per-category attribute bag Vinted
 * uses for fields that aren't top-level columns. As of 2026-08-12 the item response has
 * no `size`/`size_id` key at all, so this bag is where a size can still be.
 *
 * The bag's encoding is undocumented and has varied, so several are accepted. Anything
 * unrecognised yields null and the caller fails safe — returning a wrong id here would
 * put a wrong size on a public listing, which is worse than refusing to relist.
 */
function attributeId(src, codes) {
  if (!Array.isArray(src.item_attributes)) return null;
  for (const attr of src.item_attributes) {
    const code = String(attr?.code ?? attr?.name ?? attr?.type ?? '').toLowerCase();
    if (!codes.includes(code)) continue;
    for (const candidate of [attr.ids, attr.value_ids, attr.id, attr.value_id]) {
      if (Array.isArray(candidate) && candidate[0] != null) return candidate[0];
      if (typeof candidate === 'number') return candidate;
    }
  }
  return null;
}

/**
 * The values of every field that might carry a condition or size, for the diagnostic log.
 *
 * Key names alone were not enough to identify where Vinted moved these: `status` is
 * present but is not the `{id}` shape, and no size key exists. `color1` is included as a
 * shape reference — colour still resolves, so its encoding shows the convention the
 * others probably follow. Matching on a pattern rather than a fixed list means the next
 * rename is caught too.
 */
const PROBE_KEY_PATTERN = /size|status|condition|attribute|^color1$/i;

export function fieldProbe(src = {}) {
  const probe = {};
  for (const [key, value] of Object.entries(src)) {
    if (PROBE_KEY_PATTERN.test(key)) probe[key] = value;
  }
  return probe;
}

/**
 * The item's size id, across the same shifting shapes. Null when absent — a guessed size
 * would be wrong information in a public listing, so the caller must fail instead.
 */
export function sizeId(src) {
  return src.size_id
    ?? src.size?.id
    ?? (typeof src.size === 'number' ? src.size : null)
    ?? attributeId(src, ['size'])
    ?? null;
}

/**
 * Read engagement counters off a source item.
 * Field names vary across Vinted regions/API versions, so each metric tries several
 * known aliases and defaults to 0. Drives the "active interest" warning.
 */
export function extractInterest(src) {
  return {
    favourites: src.favourite_count ?? src.total_users_favoured ?? src.total_favourites ?? src.users_favoured ?? 0,
    views: src.view_count ?? src.views_count ?? src.total_views ?? 0,
    conversations: src.conversation_count ?? src.messages_count ?? 0
  };
}

/**
 * Pick the best usable URL for a photo, tolerating the various shapes Vinted returns.
 * Preference: full-size → display url → high-res → largest thumbnail. Null if none.
 */
export function pickPhotoUrl(photo) {
  return photo.full_size_url
    || photo.url
    || photo.high_resolution?.url
    || photo.thumbnails?.[photo.thumbnails.length - 1]?.url
    || null;
}

/**
 * The source photo's orientation, so portrait pictures aren't flipped on re-upload.
 * Lives under high_resolution on most items; falls back to a top-level field, then 0.
 */
export function photoOrientation(photo) {
  return photo.high_resolution?.orientation ?? photo.orientation ?? 0;
}

/**
 * Parse Vinted's `validation_error` response body into a list of { field, value }.
 * Returns null for anything that isn't a recognisable validation error.
 *
 * Vinted's create endpoint rejects payloads with a body like:
 *   { "message_code": "validation_error",
 *     "errors": [ { "field": "color", "value": "Wähle ein Farbe, um fortzufahren" } ] }
 * This happens e.g. when the source item has no colour set but the category now requires
 * one. Surfacing the field + message lets the user fix the original and retry.
 */
export function parseValidationErrors(body) {
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    if (j?.message_code === 'validation_error' && Array.isArray(j.errors) && j.errors.length) {
      return j.errors.map(e => ({ field: e.field, value: e.value }));
    }
  } catch { /* not JSON / not a validation error */ }
  return null;
}
