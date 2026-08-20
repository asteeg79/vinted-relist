/**
 * The Render-Modell for the studio — every decision about a Draft lives here.
 *
 * WHY THIS FILE EXISTS. The review screen is the actual safety net of the auto-listing
 * feature, and `studio/*` is the one zone the project deliberately does not unit-test.
 * `gates.js` already solved this shape of problem: the decision is made in `lib/`, the UI
 * only renders. So the studio calls `draftView()` and then does nothing but `textContent`
 * and `appendChild` — it never asks "is this field good enough".
 *
 * THE RULE (KONZEPT §6.4, Entscheidung 14): a field below the confidence threshold blocks
 * publishing until the user confirms it — not just a missing mandatory field. A category
 * found by a mid-confidence match is exactly what slips through when clicking quickly, and
 * it produces a wrongly filed article.
 *
 * Pure: no chrome.*, no DOM, no I/O.
 */
import { PROFILES, profileFor, buildTitle } from './title.js';
import { memoryKey, recallPrice } from './price-memory.js';
import { belowFloor } from './price.js';

/** Feldzustand. Publishing is released only when no field is in the last two. */
export const FIELD_OK = 'ok';
export const FIELD_NEEDS_CONFIRMATION = 'needs_confirmation';
export const FIELD_MISSING = 'missing';

const DEFAULT_THRESHOLD = 0.8;

/**
 * Which fields a Warengruppe shows, and which of them block when empty.
 *
 * `required` follows the profile's mandatory title slots (a missing mandatory slot is a
 * blocker, KONZEPT §7.3) plus the colour, which Vinted demands for most categories.
 * Material is shown where it matters but never blocks — it is a nice-to-have on a listing.
 */
const LAYOUT = {
  clothing:    { fields: ['brand', 'category', 'size', 'color'], required: ['brand', 'category', 'size', 'color'] },
  shoes:       { fields: ['brand', 'category', 'size', 'color'], required: ['brand', 'category', 'size', 'color'] },
  accessories: { fields: ['brand', 'category', 'color', 'material'], required: ['brand', 'category', 'color'] },
  media:       { fields: ['brand', 'category'], required: ['category'] },
  generic:     { fields: ['brand', 'category', 'color'], required: ['category', 'color'] }
};

/**
 * Shown as a row for every article, whatever the group.
 *
 * The description is NOT among them: it is a paragraph with its own text area, and a
 * second one-line row showing the same text was only confusing. It still blocks when
 * empty — see `descriptionState` on the returned view.
 */
const UNIVERSAL = ['condition', 'price'];

const LABELS = {
  brand: 'Marke',
  category: 'Kategorie',
  size: 'Größe',
  color: 'Farbe',
  material: 'Material',
  condition: 'Zustand',
  price: 'Preis',
  description: 'Beschreibung'
};

/** A book has an author and a title, not a brand and a category. */
const MEDIA_LABELS = { brand: 'Autor/Marke', category: 'Titel' };

/** Draft field → the key `resolve.js` files its answer under. */
const RESOLVED_AS = { brand: 'brand', category: 'catalog', size: 'size', color: 'color' };

const text = value => (typeof value === 'string' ? value.trim() : (value == null ? '' : String(value).trim()));
const filled = value => value != null && value !== '' && text(value) !== '';

/**
 * How far a size can be trusted (KONZEPT §7.2). A size read off the label is solid; one
 * estimated from proportions is not, and must never go out unasked.
 */
function sizeConfidence(source) {
  if (source === 'label_photo') return 1;
  if (source === 'estimated') return 0.5;
  return 0;
}

/**
 * The complete render model for one draft.
 *
 * Inputs — all optional, so the studio can render an empty screen before the analysis:
 *   analysis      the parsed AI answer (lib/ai.js)
 *   resolved      { brand, catalog, size, color } from lib/resolve.js, each
 *                 { id, label, confidence, candidates }
 *   settings      merged settings (threshold, pre-set condition)
 *   confirmations { <field>: true } — what the user has actively confirmed
 *   photos        per photo, in intake order: { touchesEdge } from lib/crop.js
 *   price         { value, source } or null — never an estimate (KONZEPT §7.4)
 *   condition     the chosen condition; falls back to the pre-set one
 *   overrides     values the user typed; they count as confirmed (except the condition)
 *   priceMemory   the store from lib/price-memory.js, for the "last time you charged…" hint
 *
 * Returns { profile, title, description, descriptionState, fields, photos, priceKey,
 * priceHint, canPublish, blockers }.
 */
export function draftView({
  analysis = null,
  resolved = {},
  settings = {},
  confirmations = {},
  photos = [],
  price = null,
  condition = null,
  overrides = {},
  priceMemory = {}
} = {}) {
  const threshold = settings.draftConfidenceThreshold ?? DEFAULT_THRESHOLD;
  const profile = profileFor(analysis?.category_group);
  const profileName = Object.keys(PROFILES).find(name => PROFILES[name] === profile) || 'generic';
  const layout = LAYOUT[profileName] || LAYOUT.generic;

  const values = {
    brand: overrides.brand ?? resolved.brand?.label ?? analysis?.brand,
    category: overrides.category ?? resolved.catalog?.label ?? analysis?.type,
    size: overrides.size ?? resolved.size?.label ?? analysis?.size_label,
    color: overrides.color ?? resolved.color?.label ?? analysis?.colors?.[0],
    material: overrides.material ?? analysis?.material,
    // No fallback to the settings' symbolic default: that is a preference, not a Vinted
    // `status_id`, and holding both kinds of value in one field is how a draft could get
    // confirmed with a condition Vinted has never heard of. `lookup.preselectCondition`
    // turns the preference into a real id once the list is known.
    condition: overrides.condition ?? condition,
    // The typed value wins over the fetched range — otherwise entering a price does
    // nothing at all, which is exactly what it did before.
    price: toPrice(overrides.price ?? price?.value)
  };

  const confidences = {
    brand: resolved.brand?.confidence ?? analysis?.brand_confidence,
    category: resolved.catalog?.confidence ?? analysis?.type_confidence,
    size: resolved.size?.confidence ?? sizeConfidence(analysis?.size_source),
    // Colour and material carry no confidence of their own: a colour is visually
    // unambiguous, and it is the resolution against Vinted's list that can go wrong.
    color: resolved.color?.confidence,
    material: undefined
  };

  const buildField = key => {
    const value = values[key];
    const has = filled(value);
    const resolution = resolved[RESOLVED_AS[key]];
    const candidates = Array.isArray(resolution?.candidates) ? resolution.candidates : [];
    const required = layout.required.includes(key) || UNIVERSAL.includes(key);
    // A typed value is a decision the user already made — except for the condition,
    // which stays confirmation-bound however it got its value.
    const confirmed = confirmations[key] === true
      || (key !== 'condition' && filled(overrides[key]));
    const note = key === 'price' ? underFloor(value, settings.draftMinPrice) : null;

    return {
      key,
      label: (profileName === 'media' && MEDIA_LABELS[key]) || LABELS[key],
      value: has ? value : null,
      id: resolution?.id ?? null,
      confidence: confidences[key] ?? null,
      candidates,
      required,
      note,
      state: fieldState({ key, has, required, confirmed, candidates, note, confidence: confidences[key], threshold })
    };
  };

  // The description is composed FROM the fields, so it can only be built once they exist.
  // That is what makes a corrected material show up in the text instead of leaving the
  // description contradicting the field right above it.
  const fields = [...layout.fields, ...UNIVERSAL].map(buildField);
  const description = composeDescription(analysis, fields, overrides);
  const descriptionState = filled(description) ? FIELD_OK : FIELD_MISSING;

  const blockers = fields
    .filter(f => f.state !== FIELD_OK)
    .map(f => f.note || `${f.label} ${f.state === FIELD_MISSING ? 'fehlt' : 'bestätigen'}`);
  if (descriptionState !== FIELD_OK) blockers.push('Beschreibung fehlt');

  // What this seller charged for something comparable. Offered, never applied: it is a
  // hint from their own history, not a price the tool invented (KONZEPT §7.4).
  const priceKey = memoryKey({
    categoryGroup: profileName,
    brand: values.brand,
    type: values.category
  });
  const priceHint = values.price == null ? recallPrice(priceMemory, priceKey) : null;

  return {
    profile: profileName,
    title: buildTitle(titleSlots(profileName, values), profile),
    description,
    descriptionState,
    fields,
    photos: orderPhotos(analysis, photos),
    priceKey,
    priceHint,
    canPublish: blockers.length === 0,
    blockers
  };
}

/**
 * One field's Feldzustand.
 *
 * The order matters: an empty optional field is `ok` (there is nothing to confirm), the
 * pre-set condition is never `ok` on its own, and an ambiguity outranks a high confidence
 * — two equally good candidates mean the resolution picked, it did not know.
 */
function fieldState({ key, has, required, confirmed, candidates, note, confidence, threshold }) {
  if (!has) return required ? FIELD_MISSING : FIELD_OK;
  if (confirmed) return FIELD_OK;
  // A price below the user's own floor is the case the setting exists for: a wrong
  // category gives a wrong range, and a branded piece goes out at t-shirt money.
  if (note) return FIELD_NEEDS_CONFIRMATION;
  // The pre-selection pulls: whoever clicks quickly lands on "Sehr gut" systematically,
  // including for pieces that are merely "Gut". The forced confirmation is the
  // counterweight, so it blocks rather than merely marking (KONZEPT §7.5).
  if (key === 'condition') return FIELD_NEEDS_CONFIRMATION;
  if (candidates.length > 1) return FIELD_NEEDS_CONFIRMATION;
  if (confidence != null && confidence < threshold) return FIELD_NEEDS_CONFIRMATION;
  return FIELD_OK;
}

/** A price, or null. A typed value arrives as a string; anything unusable is not a price. */
function toPrice(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** The floor from the settings, as a sentence — null when it does not apply. The rule
 *  itself lives in price.js; this only puts words to it. */
function underFloor(price, floor) {
  return belowFloor(price, floor) ? `Preis liegt unter deiner Untergrenze von ${floor} € — bestätigen` : null;
}

/**
 * The description: the model's sentence, then its facts as lines.
 *
 * A fact whose label names a field we track is re-read FROM that field, so correcting the
 * material in the form corrects it in the text too. Facts the form does not know
 * (Passform, Besonderheit) keep the model's value. Once the user writes their own text,
 * that wins outright and nothing is recomposed under them.
 */
function composeDescription(analysis, fields, overrides) {
  if (filled(overrides.description)) return overrides.description;
  if (!analysis) return '';

  const byLabel = new Map(fields.map(field => [field.label.toLowerCase(), field.value]));
  const lines = (analysis.description_facts || []).map(fact => {
    const label = text(fact?.label);
    const tracked = byLabel.get(label.toLowerCase());
    const value = tracked === undefined ? text(fact?.value) : tracked;
    return label && filled(value) ? `• ${label}: ${value}` : null;
  });

  return [text(analysis.description_sentence), ...lines].filter(Boolean).join('\n');
}

/**
 * Map the draft's fields onto the profile's title slots. The model always reports
 * brand/type/size/colour; a book's work and author live in the same two fields under
 * different names.
 */
function titleSlots(profileName, v) {
  if (profileName === 'media') return { work: v.category, author: v.brand, format: null };
  if (profileName === 'accessories') return { brand: v.brand, type: v.category, color: v.color, material: v.material };
  if (profileName === 'generic') return { brand: v.brand, type: v.category, model: null, color: v.color };
  return { brand: v.brand, type: v.category, size: v.size, color: v.color };
}

/**
 * The photo row: the model's suggested order first, then anything it left out, each photo
 * exactly once. Indices that don't exist are dropped rather than rendered as a gap.
 *
 * A warning marks a photo, it never blocks (KONZEPT §5.4/§5.6): re-shooting is the user's
 * call, and a suboptimal cover picture costs clicks, not correctness.
 */
function orderPhotos(analysis, photos) {
  const count = photos.length;
  const seen = new Set();
  const ordered = [];

  for (const entry of analysis?.photo_order || []) {
    const index = entry?.index;
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) continue;
    seen.add(index);
    ordered.push({ index, role: text(entry.role), croppedOff: entry.cropped_off === true });
  }
  for (let index = 0; index < count; index++) {
    if (!seen.has(index)) ordered.push({ index, role: '', croppedOff: false });
  }

  return ordered.map((photo, position) => {
    const source = photos[photo.index] || {};
    return {
      index: photo.index,
      role: photo.role,
      isCover: position === 0,
      // Echoed so the studio can show that the photo really went through the pipeline
      // and at what size — otherwise "was it processed?" is unanswerable by looking.
      mode: source.mode ?? null,
      width: source.width ?? null,
      height: source.height ?? null,
      ...photoWarning(photo.croppedOff, source)
    };
  });
}

/**
 * Two signals, and they are not equal in weight.
 *
 * `cropped_off` is the model's verdict on the FINISHED image — it looked at the picture.
 * `touchesEdge` is the heuristic saying it could not trim anything on some side, which a
 * shadow or a fold causes just as readily as a clipped sleeve. So once the model has
 * judged a photo, its answer stands alone; before that the heuristic's observation is
 * worth showing, but as a note, not an alarm.
 */
function photoWarning(croppedOff, photo) {
  if (croppedOff) {
    return { warning: 'Objekt ragt über den Rand — padden, korrigieren oder neu aufnehmen.', warningLevel: 'warn' };
  }
  if (photo.judged) return { warning: null, warningLevel: null };
  if (photo.touchesEdge) {
    return { warning: 'Kein Rand zum Abschneiden gefunden — die Erkennung prüft das gleich mit.', warningLevel: 'note' };
  }
  return { warning: null, warningLevel: null };
}
