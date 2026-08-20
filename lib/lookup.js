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
 *
 * Returns `{ resolved, price, conditions, requiredFields, warnings }`. Nothing throws for
 * an unresolvable field — it comes back unresolved, and `draft-view.js` blocks on it.
 */
export async function lookupDraft({ analysis, taxonomy, picks = {}, price = null, condition = null } = {}) {
  const resolved = {};
  const warnings = [];
  if (!analysis || !taxonomy) return { resolved, price: null, conditions: [], requiredFields: [], warnings };

  // --- category: everything else hangs off it ---------------------------------------
  const catalogs = await taxonomy.catalogs();
  // Only leaves can carry an article; an inner node like "Kleidung" is not a category you
  // can list in, and offering one as a candidate would produce a rejected create.
  const leaves = catalogs.filter(c => c.isLeaf);
  resolved.catalog = resolveField({ label: analysis.type, candidates: leaves, pick: picks.category });
  const catalogId = resolved.catalog.id;

  if (catalogId == null) {
    // Without a category there is no size set, no brand list and no price. Stopping here
    // is the honest answer — guessing a category to keep going is how an article ends up
    // filed wrong.
    warnings.push('Kategorie nicht aufgelöst — Marke, Größe und Preis brauchen sie.');
    return { resolved, price: priceForDraft(price, null), conditions: [], requiredFields: [], warnings };
  }

  // --- the three lists that depend on the category ----------------------------------
  const [brands, colors, sizes, conditions, requiredFields] = await Promise.all([
    taxonomy.brands(catalogId),
    taxonomy.colors(),
    taxonomy.sizes(catalogId),
    taxonomy.conditions(catalogId),
    taxonomy.requiredFields(catalogId)
  ]);

  resolved.brand = resolveField({ label: analysis.brand, candidates: brands, pick: picks.brand });
  resolved.color = resolveField({ label: analysis.colors?.[0], candidates: colors, pick: picks.color });
  // Vinted writes "M / 38 / 10" and the label says "M" — see resolve.js on `splitOn`.
  resolved.size = resolveField({ label: analysis.size_label, candidates: sizes, pick: picks.size, splitOn: '/' });

  if (brands.find(b => b.id === resolved.brand.id)?.requires_authenticity_check) {
    warnings.push('Diese Marke verlangt Echtheitsnachweise — ohne Fotos von Logo und Etikett wird das Inserat versteckt.');
  }

  // --- the price, last, because it needs all three ids ------------------------------
  const suggestion = await taxonomy.priceSuggestion({
    catalogId,
    brandId: resolved.brand.id,
    statusId: condition
  });

  return { resolved, price: priceForDraft(price, suggestion), conditions, requiredFields, warnings };
}

/**
 * Which of Vinted's conditions the pre-selection points at, or null.
 *
 * The settings hold a symbolic default ("very_good") because the real `status_id`s are
 * Vinted's and per-marketplace — hardcoding them was rejected in `taxonomy.js` for the
 * same reason. This matches the default's German label against the list Vinted returned;
 * if nothing matches, NOTHING is pre-selected and the field simply blocks. A pre-selection
 * is a cursor position, never an assertion (§7.5), so failing to place it costs a click
 * and never a wrong condition on a public listing.
 */
export function preselectCondition(conditions, label) {
  const wanted = normaliseLabel(label);
  if (!wanted) return null;
  const hit = (conditions || []).find(c => normaliseLabel(c.title) === wanted);
  return hit ? hit.id : null;
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
