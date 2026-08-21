/**
 * Die Vorbereitung — was aus einer Erkennung wird, bevor irgendetwas geschrieben wird.
 *
 * This is Stufe 2 end to end: take the model's analysis, resolve every field against
 * Vinted's own lists, and fetch the price range. It touches Vinted only for READS, so it
 * runs freely alongside a relist and takes no lock (§4.5). Nothing here uploads a photo.
 *
 * THE ORDER IS A DEPENDENCY, NOT A PREFERENCE. The size set and the condition list hang
 * off the category; the price range needs category, brand and condition together. Getting
 * this wrong doesn't fail loudly — it silently resolves a size against the wrong set. So
 * the order lives in `resolveOrder()` and this module walks it.
 *
 * The taxonomy client is the seam: `lookupDraft` takes it, so the tests run against a
 * fake and no test ever reaches the network.
 */
import { resolveField, resolveOrder, crossCheck, normaliseLabel } from './resolve.js';
import { priceForDraft } from './price.js';
import { chooseCondition } from './condition.js';
import { AuthError } from './errors.js';

/**
 * Resolve one analysis into ids, and fetch what depends on them.
 *
 * Inputs:
 *   analysis   the parsed AI answer (lib/ai.js)
 *   taxonomy   a client from lib/taxonomy.js
 *   picks      `{ category, brand, … }` — ids the user or the model chose for an
 *              ambiguity; each one still passes `validatePick`
 *   price      the draft's current price, so a manual one survives (Entscheidung W3)
 *   condition  the chosen condition id, when there is one
 *   conditionMeta  where that id came from — so a kept proposal keeps its explanation
 *
 * Returns `{ resolved, price, conditions, condition, warnings }`. Nothing throws for an
 * unresolvable field — it comes back unresolved, and `draft-view.js` blocks on it.
 */
export async function lookupDraft({ analysis, taxonomy, picks = {}, price = null, condition = null, conditionMeta = null, settings = {}, labels = {} } = {}) {
  const resolved = {};
  const warnings = [];
  const empty = { id: null, source: null, value: null, evidence: null };
  if (!analysis || !taxonomy) {
    return { resolved, price: null, conditions: [], condition: empty, warnings };
  }

  // --- category: everything else hangs off it ---------------------------------------
  const catalogs = await taxonomy.catalogs();
  // Only leaves can carry an article; an inner node like "Kleidung" is not a category you
  // can list in, and offering one as a candidate would produce a rejected create.
  const leaves = catalogs.filter(c => c.isLeaf);
  // What the user typed into the category field beats what the model called the article.
  // Without this the field was decorative: typing "T-Shirts" over an unresolvable "Hoodie"
  // changed the text and nothing else, and the draft stayed blocked with no way out.
  const typeLabel = normaliseLabel(labels.category) ? labels.category : analysis.type;
  resolved.catalog = resolveField({ label: typeLabel, candidates: leaves, pick: picks.category });

  // Exact title equality is a narrow door, and the model does not know Vinted's wording:
  // it says "Hoodie", the leaf is called "Hoodies & Sweaters", and nothing matches. Vinted
  // runs its own keyword search over the same tree — asking it is strictly better than
  // leaving the user with a field they cannot fill.
  if (resolved.catalog.id == null && !resolved.catalog.candidates.length && picks.category == null) {
    const found = await searchCatalog(taxonomy, typeLabel, leaves);
    if (found) {
      resolved.catalog = found;
      if (found.id != null) warnings.push(`Kategorie über Vinteds Suche gefunden: „${found.label}" — bitte bestätigen.`);
    }
  }
  const catalogId = resolved.catalog.id;

  if (catalogId == null) {
    // Without a category there is no size set, no brand list and no price. Stopping here
    // is the honest answer — guessing a category to keep going is how an article ends up
    // filed wrong.
    //
    // The CONDITION is the exception, and deliberately so: it does not depend on the
    // category (all five categories probed on 2026-08-20 offer the same stages), and
    // leaving the field empty and greyed out while the category is being sorted out is
    // what made the studio look broken. The general list stands in until there is a
    // category; the per-category one then replaces it below.
    warnings.push('Kategorie nicht aufgelöst — Marke, Größe und Preis brauchen sie.');
    const conditions = await taxonomy.statuses().catch(() => []);
    return {
      resolved,
      price: priceForDraft(price, null),
      conditions,
      condition: keepOrChoose(condition, conditionMeta, conditions, analysis, settings),
      warnings
    };
  }

  // --- the lists that depend on the category ----------------------------------------
  const [brands, colors, sizes, conditions] = await Promise.all([
    taxonomy.brands(catalogId),
    taxonomy.colors(),
    taxonomy.sizes(catalogId),
    taxonomy.conditions(catalogId)
  ]);

  resolved.brand = resolveField({ label: analysis.brand, candidates: brands, pick: picks.brand });
  resolved.color = resolveField({ label: analysis.colors?.[0], candidates: colors, pick: picks.color });
  // Ohne ID ist die Farbe ein Blocker (`NEEDS_ID`), und ein Blocker braucht einen Ausweg.
  // Für die Kategorie ist das die Suche und das Textfeld; die Farbe hat weder das eine noch
  // das andere — ein getipptes Wort wird hier gar nicht aufgelöst. Also ist der Ausweg die
  // Liste selbst: 29 Einträge, das ist ein Auswahlfeld und keine Zumutung. Sonst stünde ein
  // Draft mit „Petrol" vor einer Sperre, die er nicht öffnen kann.
  if (resolved.color.id == null && !resolved.color.candidates.length && colors.length) {
    resolved.color = { ...resolved.color, candidates: colors.map(c => ({ id: c.id, label: c.title })) };
  }
  // Vinted writes "M / 38 / 10" and the label says "M" — see resolve.js on `splitOn`.
  resolved.size = resolveField({ label: analysis.size_label, candidates: sizes, pick: picks.size, splitOn: '/' });

  if (analysis.size_label && sizes.length && resolved.size.id == null && !resolved.size.candidates.length) {
    // Worth saying out loud: the model DID read a size and Vinted's set does not contain
    // it. That is a different problem from "no size on any photo", and only one of the two
    // is fixed by taking another picture.
    warnings.push(`Größe "${analysis.size_label}" steht in Vinteds Liste für diese Kategorie nicht — bitte von Hand wählen.`);
  }

  if (brands.find(b => b.id === resolved.brand.id)?.requires_authenticity_check) {
    warnings.push('Diese Marke verlangt Echtheitsnachweise — ohne Fotos von Logo und Etikett wird das Inserat versteckt.');
  }

  // --- the condition, BEFORE the price ----------------------------------------------
  // Order, not taste: the price range needs `status_id`, and an incomplete query is
  // answered 200-with-nothing. Choosing the condition afterwards is why no price
  // suggestion ever appeared on the first pass.
  const chosen = keepOrChoose(condition, conditionMeta, conditions, analysis, settings);

  const suggestion = await taxonomy.priceSuggestion({
    catalogId,
    brandId: resolved.brand.id,
    statusId: chosen.id
  });

  return { resolved, price: priceForDraft(price, suggestion), conditions, condition: chosen, warnings };
}

/**
 * Vinteds eigene Kategoriesuche als Rückfallebene — oder null.
 *
 * A single hit is ADOPTED, but at a confidence low enough that `draft-view.js` demands a
 * confirmation. That is the same bargain Entscheidung C strikes at publishing time: an
 * answer from Vinted about Vinted's own tree beats having none, and a person still looks
 * at it before it goes out. Several hits are offered as a choice rather than ranked —
 * "Herren > T-Shirts" versus "Damen > T-Shirts" is not ours to decide.
 *
 * Only leaves count: an inner node cannot carry an article, and offering one would produce
 * a create that Vinted rejects. A failing search is simply no answer — it must never take
 * the draft down with it.
 *
 * MIT EINER AUSNAHME: eine abgelaufene Sitzung. Die wurde hier mitverschluckt und kam als
 * „„T-Shirt" ist keine Vinted-Kategorie" wieder heraus — eine Auskunft über Vinteds Baum,
 * obwohl Vinted gar nicht geantwortet hat. Das ist dieselbe Sorte stiller Fehlschlag wie
 * die 200-mit-leerer-Liste bei den Größen: nach außen ein Befund, in Wahrheit keiner. Ein
 * `AuthError` fliegt deshalb durch, damit oben der Satz steht, der die Abhilfe nennt.
 */
async function searchCatalog(taxonomy, label, leaves) {
  if (!label || typeof taxonomy.searchCatalogs !== 'function') return null;

  let ids = [];
  try {
    ids = await taxonomy.searchCatalogs(label);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return null;
  }

  const hits = (ids || []).map(id => leaves.find(c => c.id === id)).filter(Boolean);
  if (!hits.length) return null;

  const base = { label, id: null, confidence: 0, candidates: [], source: 'search', needsPick: false, rejectedPick: false };
  if (hits.length === 1) {
    // Deliberately below the 0.8 threshold: found, not verified.
    return { ...base, id: hits[0].id, label: hits[0].title, confidence: 0.5 };
  }
  return {
    ...base,
    candidates: hits.map(c => ({ id: c.id, label: c.path || c.title })),
    needsPick: true
  };
}

/**
 * Keep what was already chosen, or choose one.
 *
 * A condition that is already set stays — unless the list changed under it (a new category
 * can offer different stages, and `/api/v2/statuses` carries one that the upload list does
 * not). An id that is no longer on offer is dropped rather than carried along, because it
 * would be rejected at create time with a message nobody can act on.
 *
 * WOHER SIE KAM, BLEIBT DABEI STEHEN. Bisher wurde jede behaltene Stufe als `source: 'user'`
 * zurückgegeben — auch die, die eine Sekunde vorher die Erkennung vorgeschlagen hatte. Im
 * Log vom 2026-08-21 gut zu sehen: `conditionFrom: "ai"`, dann eine Kategorie gewählt, und
 * ohne dass jemand den Zustand angefasst hätte `conditionFrom: "user"`. Damit verschwand
 * der Hinweis unter dem Feld („Von der Erkennung vorgeschlagen: …") — und der ist der
 * ganze Unterschied zwischen einem begründeten Vorschlag und einem unerklärten „Gut", das
 * zum Wegklicken einlädt (§7.5).
 */
function keepOrChoose(condition, meta, conditions, analysis, settings) {
  if (condition != null && (conditions || []).some(c => String(c.id) === String(condition))) {
    return {
      id: condition,
      source: meta?.source || 'user',
      value: meta?.value ?? null,
      evidence: meta?.evidence ?? null
    };
  }
  return chooseCondition({ conditions, analysis, settings });
}

/**
 * Fold Vinted's own photo recognition into an existing resolution (Entscheidung C).
 *
 * Called at publishing time, once the photos are up and Vinted has looked at them.
 * Agreement passes, a field we could not resolve adopts Vinted's answer, and a
 * disagreement empties the field and offers both. See `crossCheck`.
 */
export function applySuggestions(resolved, suggestions = {}) {
  const checked = { ...resolved };
  for (const [key, suggestion] of Object.entries(suggestions)) {
    if (checked[key]) checked[key] = crossCheck(checked[key], suggestion);
  }
  return checked;
}

/** Re-exported so a caller never has to remember the dependency order itself. */
export { resolveOrder };
