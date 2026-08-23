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
import { conditionTitleFor } from './condition.js';
import { normaliseLabel } from './resolve.js';
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

/**
 * Fields whose VALUE is worthless without Vinted's id behind it — with the word for it.
 *
 * TWO, und beide sind keine Geschmacksfrage. Die Kategorie, weil `buildNewItemPayload`
 * ohne `catalog_id` wirft. Und die Farbe, weil sie im Titel steht und Vinted sie für die
 * Kleidungskategorien verlangt: ohne ID geht `color_ids: []` raus, und das Inserat hat
 * keine Farbe. Marke und Größe sind in der Payload nullbar (Vinted nimmt sogar eine
 * Freitext-Marke) — dort ist ein Wort ohne ID das kleinere Übel.
 *
 * WHY THIS EXISTS. The category field falls back to the model's raw word — "Hoodie" —
 * when nothing resolved, so it LOOKS filled. It then sat at needs_confirmation, the user
 * pressed "Passt", and publishing was released for a draft that had no `catalog_id` at
 * all. The failure surfaced at payload time: after the lock was taken and three photos
 * were already uploaded. Confirming a name cannot conjure an id, so no amount of clicking
 * may turn this state into `ok`.
 *
 * DIE FARBE KAM 2026-08-21 DAZU, aus demselben Loch von der anderen Seite: nach einem
 * Konflikt der Gegenprobe leert `crossCheck` das Feld und bietet beide Antworten an — das
 * Feld zeigt aber weiter „Blau", stand auf `needs_confirmation`, und ein Klick auf „Passt"
 * gab das Veröffentlichen frei. Genau der Zwang zur Neuauswahl, wegen dem die Farbe ein
 * Blocker ist, ließ sich also wegklicken.
 *
 * DIE GRÖSSE KAM 2026-08-23 DAZU, und zwar durch einen echten Fehlschlag. Hier stand, sie
 * sei „in der Payload nullbar" — Vinted sieht das anders: `size_id: null` wird mit
 * `400 size: Wähle ein Größe, um fortzufahren` abgelehnt, nach dem Foto-Upload. Auf dem
 * Bildschirm stand `Größe=M[ok]`, im Kopf `größe=—`; das Modell hatte „MD/M/M" vom Etikett
 * gelesen, und das ist keine Vinted-Größe. Ein Wort ohne ID sieht bei der Größe genauso
 * gefüllt aus wie bei der Kategorie.
 *
 * Die Prüfung greift nur, wo das Feld auch verlangt wird (`required`): Medien und
 * Accessoires führen gar keine Größe, und für sie ändert sich nichts.
 */
const NEEDS_ID = new Map([
  // Das Wort für die Sache, und der Rat, wenn nichts zur Auswahl steht. Der Rat war
  // einmal für alle drei derselbe — der der Kategorie. Bei der Größe stand dann
  // „„152" ist keine Vinted-Größe — anderen Begriff eintippen, z. B. „T-Shirts"": ein
  // Beispiel aus dem falschen Feld, und ein Rat, der ins Leere führte, weil ein getipptes
  // Größenwort damals nirgends aufgelöst wurde.
  ['category', { noun: 'Vinted-Kategorie', advice: 'anderen Begriff eintippen, z. B. „T-Shirts"' }],
  ['color', { noun: 'Vinted-Farbe', advice: 'unten eine aus der Liste wählen' }],
  ['size', { noun: 'Vinted-Größe', advice: 'Größe wie in Vinteds Liste eintippen, z. B. „152" oder „M"' }]
]);

/**
 * Which FIELDS a cross-check disagreed about, by field key.
 *
 * `crossCheck` marks a resolution `agreed: false`; this translates those into the keys the
 * studio renders, so the UI does not have to know that `catalog` is called `category` on
 * screen. Used to clear exactly the confirmations that a disagreement invalidated —
 * confirming a colour before Vinted objected is not a confirmation of the objection.
 */
export function conflictedFields(resolved = {}) {
  return Object.entries(RESOLVED_AS)
    .filter(([, resolvedKey]) => resolved[resolvedKey]?.agreed === false)
    .map(([fieldKey]) => fieldKey);
}

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
 *   condition     the chosen condition as Vinteds status_id
 *   conditions    Vinteds condition list, for turning that id back into a word
 *   overrides     values the user typed; they count as confirmed (except the condition)
 *   priceMemory   the store from lib/price-memory.js, for the "last time you charged…" hint
 *   priceReason   warum keine Preisspanne kam (lib/lookup.js) — null, wenn eine kam
 *   publishedId   die id des Inserats, das aus diesem Draft schon entstanden ist
 *
 * Returns { profile, title, description, descriptionState, fields, photos, priceKey,
 * priceHint, done, publishedId, canPublish, blockers }.
 */
export function draftView({
  analysis = null,
  resolved = {},
  settings = {},
  confirmations = {},
  photos = [],
  price = null,
  condition = null,
  conditions = [],
  conditionMeta = {},
  overrides = {},
  priceMemory = {},
  priceReason = null,
  publishedId = null
} = {}) {
  const threshold = settings.draftConfidenceThreshold ?? DEFAULT_THRESHOLD;
  const profile = profileFor(analysis?.category_group);
  const profileName = Object.keys(PROFILES).find(name => PROFILES[name] === profile) || 'generic';
  const layout = LAYOUT[profileName] || LAYOUT.generic;

  // No fallback to the settings' symbolic default: that is a preference, not a Vinted
  // `status_id`, and holding both kinds of value in one field is how a draft could get
  // confirmed with a condition Vinted has never heard of. `condition.chooseCondition`
  // turns the preference — or the model's reading — into a real id once the list is known.
  // Kein `overrides.condition`: der Zustand kommt aus einem Auswahlfeld, nie aus einem
  // Textfeld. Der Griff dorthin war ein toter Pfad — und einer, über den ein getipptes
  // Wort als `status_id` hätte einreisen können, also genau das, was der Absatz oben
  // verhindert.
  const conditionId = condition;

  const values = {
    brand: overrides.brand ?? resolved.brand?.label ?? analysis?.brand,
    category: overrides.category ?? resolved.catalog?.label ?? analysis?.type,
    size: overrides.size ?? resolved.size?.label ?? analysis?.size_label,
    color: overrides.color ?? resolved.color?.label ?? analysis?.colors?.[0],
    material: overrides.material ?? analysis?.material,
    // The WORD, not the id — every other field's `value` is what a person reads, and the
    // condition was the one exception: the summary line said "Zustand=2", which nobody can
    // check against the article in their hands. The id lives in `ids` below, where the
    // payload picks it up.
    //
    // The fallback to the bare id keeps a draft publishable while Vinted's list is still
    // being fetched: the field would otherwise read as empty and block.
    condition: conditionTitleFor(conditions, conditionId) ?? (conditionId == null ? null : String(conditionId)),
    // The typed value wins over the fetched range — otherwise entering a price does
    // nothing at all, which is exactly what it did before.
    price: toPrice(overrides.price ?? price?.value)
  };

  const confidences = {
    brand: resolved.brand?.confidence ?? analysis?.brand_confidence,
    category: resolved.catalog?.confidence ?? analysis?.type_confidence,
    // DAS KLEINERE VON BEIDEN, und das ist keine Feinheit. Die Konfidenz der Auflösung
    // sagt „die Zeichenkette hat gepasst", die Quelle sagt „so sicher war das Lesen".
    // Vorher gewann die Auflösung: eine an den Proportionen GESCHÄTZTE Größe, die zufällig
    // auf einen Listeneintrag passte, stand als `ok` da und ging ungefragt raus — genau
    // das, was §7.2 verbietet. Ein Treffer in der Liste macht eine Schätzung nicht sicherer.
    size: Math.min(resolved.size?.confidence ?? 1, sizeConfidence(analysis?.size_source)),
    // Colour and material carry no confidence of their own: a colour is visually
    // unambiguous, and it is the resolution against Vinted's list that can go wrong.
    color: resolved.color?.confidence,
    material: undefined
  };

  // Ids that come from somewhere other than a resolution. The condition is the only one:
  // it is picked from a list, not matched against one, so there is no `resolved.condition`.
  const ids = { condition: conditionId };

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
    // A name Vinted does not know. Named explicitly, because "Kategorie fehlt" next to a
    // field reading "Hoodie" is the kind of message that gets clicked past.
    const idMissing = NEEDS_ID.has(key) && required && has && (resolution?.id == null);
    const note = idMissing
      ? missingIdNote(key, value, resolution, candidates)
      : (key === 'price' ? underFloor(value, settings.draftMinPrice) : null);

    return {
      key,
      label: (profileName === 'media' && MEDIA_LABELS[key]) || LABELS[key],
      value: has ? value : null,
      id: resolution?.id ?? ids[key] ?? null,
      confidence: confidences[key] ?? null,
      candidates,
      required,
      note,
      // Unlike `note`, a hint changes nothing: it neither blocks nor lands in `blockers`.
      // It only says where the value came from, which for the condition is the whole
      // difference between "the recognition saw something" and "nobody has decided yet".
      hint: fieldHint(key, conditionMeta, priceReason, resolution),
      state: fieldState({ key, has, required, confirmed, candidates, note, idMissing, confidence: confidences[key], threshold })
    };
  };

  // The description is composed FROM the fields, so it can only be built once they exist.
  // That is what makes a corrected material show up in the text instead of leaving the
  // description contradicting the field right above it.
  const fields = [...layout.fields, ...UNIVERSAL].map(buildField);
  const description = composeDescription(analysis, fields, overrides);

  /**
   * What the article is CALLED, as opposed to where it is FILED.
   *
   * These stopped being the same thing the moment the category resolved to a real leaf.
   * Vinted files a T-shirt under "Einfarbige T-Shirts" — plural, with a qualifier that
   * belongs in a taxonomy and not in a headline — and the title came out as "Superdry
   * Einfarbige T-Shirts M Blau". Resolving the category made the title WORSE.
   *
   * So the title takes the model's own word for the thing, and the category field keeps
   * Vinted's. A word the user typed themselves still wins over both.
   */
  const typeName = text(overrides.category) || text(analysis?.type) || text(resolved.catalog?.label);
  // Words the model's own sentence still asserts that the fields have since corrected.
  // Skipped once the user wrote their own text — then the text is theirs, contradictions
  // included.
  const stale = filled(overrides.description) ? [] : staleMentions(analysis, fields, typeName);
  const descriptionState = !filled(description)
    ? FIELD_MISSING
    : (stale.length ? FIELD_NEEDS_CONFIRMATION : FIELD_OK);

  const blockers = fields
    .filter(f => f.state !== FIELD_OK)
    .map(f => f.note || `${f.label} ${f.state === FIELD_MISSING ? 'fehlt' : 'bestätigen'}`);
  if (descriptionState === FIELD_MISSING) blockers.push('Beschreibung fehlt');
  if (descriptionState === FIELD_NEEDS_CONFIRMATION) {
    blockers.push(`Beschreibung sagt noch „${stale.join('", „')}" — Text anpassen`);
  }
  // KEIN BLOCKER. Ein Draft, aus dem ein Inserat geworden ist, ist fertig, nicht mangelhaft
  // — und „Noch offen: Bereits eingestellt" liest sich wie ein Fehler, obwohl es der Erfolg
  // ist. `blockers` beantwortet „was fehlt noch"; hierfür gibt es `done`.
  //
  // Sperren muss es trotzdem: ohne das war der Knopf nach dem Erfolg sofort wieder aktiv —
  // derselbe Draft, dieselben Fotos, ein zweites öffentliches Inserat, und ohne Gate, weil
  // die Erst-Bestätigung längst gemerkt ist. Wer die Erfolgsmeldung übersieht und noch
  // einmal klickt, verkauft ein Stück zweimal.
  const done = publishedId != null;

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
    title: buildTitle(titleSlots(profileName, values, typeName), profile),
    description,
    descriptionState,
    fields,
    photos: orderPhotos(analysis, photos),
    priceKey,
    priceHint,
    done,
    publishedId,
    canPublish: blockers.length === 0 && !done,
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
function fieldState({ key, has, required, confirmed, candidates, note, idMissing, confidence, threshold }) {
  if (!has) return required ? FIELD_MISSING : FIELD_OK;
  // BEFORE `confirmed`, and that ordering is the whole point: pressing "Passt" on a
  // category Vinted has never heard of used to release publishing for a draft with no
  // catalog_id. There is nothing here a person can confirm — only something they can pick.
  if (idMissing) return FIELD_MISSING;
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

/**
 * Warum ein gefülltes Feld trotzdem keine ID hat — und was zu tun ist.
 *
 * Zwei verschiedene Lagen, und sie zu verwechseln wäre eine Falschaussage über Vinted:
 *
 *   Konflikt   Der Wert IST eine Vinted-Farbe, Vinted sieht auf den Fotos nur eine andere.
 *              Zu entscheiden ist zwischen zwei gültigen Antworten (Entscheidung C).
 *   Kein Fund  Vinted kennt das Wort nicht. Dann ist die Liste der Ausweg, und wo es keine
 *              gibt, ein anderer Begriff.
 */
function missingIdNote(key, value, resolution, candidates) {
  const { noun, advice } = NEEDS_ID.get(key);
  if (resolution?.agreed === false) {
    const both = candidates.map(c => text(c.label)).filter(Boolean).join(' oder ');
    return both
      ? `Vinted sieht auf den Fotos etwas anderes: ${both} — bitte unten entscheiden`
      : 'Vinted widerspricht — bitte unten entscheiden';
  }
  return candidates.length
    ? `„${text(value)}" ist keine ${noun} — bitte unten eine aus der Liste wählen`
    : `„${text(value)}" ist keine ${noun} — ${advice}`;
}

/**
 * Der eine Satz unter einem Feld — er blockt nie, er erklärt nur.
 *
 * Drei Anlässe, und der dritte ist der jüngste: hat der Nutzer eine Kategorie gewählt, der
 * Vinteds Fotoerkennung widerspricht, gilt seine Wahl (siehe `crossCheck`). Das darf aber
 * nicht stillschweigend geschehen — wer überstimmt, soll sehen, wen.
 */
function fieldHint(key, conditionMeta, priceReason, resolution) {
  if (key === 'condition') return conditionHint(conditionMeta);
  if (key === 'price') return priceHintFor(priceReason);
  const overridden = resolution?.overriddenBy;
  if (overridden?.length) {
    return `Vinted sieht auf den Fotos ${overridden.map(o => `„${text(o.label)}"`).join(' oder ')} — deine Wahl steht.`;
  }
  return null;
}

/**
 * Warum das Preisfeld leer ist — in einem Satz, oder null, wenn eine Spanne kam.
 *
 * Ein leeres Feld sieht aus wie ein Aussetzer, und genau so wurde es berichtet: „der
 * Preisvorschlag kommt nicht zuverlässig". In Wahrheit sind es vier verschiedene,
 * jeweils vollkommen ordentliche Lagen — und nur eine davon hat der Nutzer in der Hand.
 *
 * Gemessen am 2026-08-23: Vinteds Endpunkt antwortet nur auf Kategorie, Marke UND Zustand
 * zusammen; fehlt eines, kommt `similar_sold_items_present: false`. Und für ganze
 * Kategoriefamilien — Bücher, Comics, Briefmarken, Schreibwaren — gibt es überhaupt keine
 * Vergleichsverkäufe, auch mit allen drei IDs nicht.
 */
const PRICE_HINTS = {
  no_analysis: null,
  no_category: 'Preisspanne kommt, sobald die Kategorie steht — Vinted braucht Kategorie, Marke und Zustand zusammen.',
  no_brand: 'Ohne erkannte Marke nennt Vinted keine Spanne — Marke ergänzen oder Preis selbst setzen.',
  no_condition: 'Ohne Zustand nennt Vinted keine Spanne.',
  no_comparables: 'Vinted hat für diese Kombination keine vergleichbaren Verkäufe — der Preis ist deine Entscheidung.'
};

function priceHintFor(reason) {
  return (reason && PRICE_HINTS[reason]) || null;
}

/**
 * Where the pre-selected condition came from, in one line — or null when the user picked
 * it themselves and already knows.
 *
 * Both sources still have to be confirmed (§7.5). The wording is what separates them: a
 * proposal that names what it saw invites a check, an unexplained "Sehr gut" invites a
 * click.
 */
function conditionHint({ source, evidence } = {}) {
  if (source === 'ai') {
    return filled(evidence)
      ? `Von der Erkennung vorgeschlagen: ${text(evidence)}`
      : 'Von der Erkennung vorgeschlagen — bitte am Artikel prüfen.';
  }
  if (source === 'default') {
    return 'Voreinstellung aus den Einstellungen — die Erkennung war sich nicht sicher.';
  }
  return null;
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
 * What the model originally reported for each tracked field. The fields can be corrected;
 * the sentence it wrote cannot.
 */
const MODEL_SAID = {
  brand: a => a?.brand,
  category: a => a?.type,
  size: a => a?.size_label,
  color: a => a?.colors?.[0],
  material: a => a?.material
};

/**
 * Values the model's sentence still asserts, that a field has since been corrected away
 * from.
 *
 * THE CASE THIS EXISTS FOR, verbatim from a dry run: Vinteds cross-check said the shirt
 * was Türkis, not Blau, the user took Vinteds answer, and the listing came out as
 * "Superdry T-Shirt M Türkis" over "Blaues T-Shirt von Superdry Originals…". Title and
 * text contradicting each other in a public listing is a misdescription, and it is exactly
 * what splitting sentence from facts was supposed to prevent — except the split only
 * protects the FACTS. A value inside the prose is beyond re-derivation, so it is caught
 * instead of quietly shipped.
 *
 * Only substrings of three characters or more count: a size "M" or a colour "Ei" would
 * match half the alphabet. Comparison is on normalised text, so "Blau" is found inside
 * "Blaues".
 */
function staleMentions(analysis, fields, typeName) {
  if (!analysis) return [];
  const sentence = normaliseLabel(analysis.description_sentence);
  if (!sentence) return [];

  const found = [];
  for (const field of fields) {
    const said = MODEL_SAID[field.key]?.(analysis);
    // The category is compared against the article's NAME, not against the field: the
    // field deliberately holds Vinted's filing label ("Einfarbige T-Shirts") and differing
    // from the everyday word is its normal state, not a contradiction. Only a name the
    // user actually retyped counts.
    const now = field.key === 'category' ? typeName : field.value;
    if (!filled(said) || !filled(now)) continue;
    const wasWord = normaliseLabel(said);
    if (wasWord.length < 3 || wasWord === normaliseLabel(now)) continue;
    if (sentence.includes(wasWord)) found.push(text(said));
  }
  return found;
}

/**
 * Map the draft's fields onto the profile's title slots. The model always reports
 * brand/type/size/colour; a book's work and author live in the same two fields under
 * different names.
 */
function titleSlots(profileName, v, typeName) {
  // `typeName`, not `v.category` — the field holds Vinted's filing label, the title wants
  // the everyday name. See where typeName is derived.
  if (profileName === 'media') return { work: typeName, author: v.brand, format: null };
  if (profileName === 'accessories') return { brand: v.brand, type: typeName, color: v.color, material: v.material };
  if (profileName === 'generic') return { brand: v.brand, type: typeName, model: null, color: v.color };
  return { brand: v.brand, type: typeName, size: v.size, color: v.color };
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
