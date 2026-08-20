/**
 * String → Vinted-ID, deterministisch.
 *
 * THE INVARIANT (ADR-0005, Entscheidung W2): the model never produces an id. It produces
 * a label, and where that is ambiguous it may CHOOSE from a list we fetched — but the
 * choice goes through `validatePick`, and an id that was not in the list is discarded. A
 * guessed id ends up in a public listing, and for clothing that is a warranty case.
 *
 * THE ORDER MATTERS. The valid size set hangs off the category (`X-Enable-Multiple-Size-
 * Groups`), and the price range needs the brand id. `resolveOrder()` is that dependency,
 * written down once.
 *
 * THE CROSS-CHECK (Entscheidung C, 2026-08-16). Vinted's own photo recognition returns
 * `catalog_id`, `brand_id` and colour ids — but only after the photos are uploaded, which
 * is the writing phase (§4.5). So preparation resolves on its own, and at publishing time
 * `crossCheck` compares the two independent answers: agreement passes, disagreement blocks
 * the field. Two recognisers that disagree are worth more than one that is confident.
 *
 * Pure: no chrome.*, no DOM, no I/O.
 */

/**
 * Fold away everything that must not decide a match: case, spacing, punctuation and
 * diacritics. "Größe" and "Grosse" are the same word to a seller, and Vinted is not
 * consistent about which one it stores.
 */
export function normaliseLabel(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // ß is not a diacritic and survives NFD untouched, so "Größe" and the Swiss "Grösse"
    // would otherwise never match. Folded explicitly, before punctuation is stripped.
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Two labels per candidate, and the difference matters.
 *
 * `valueLabel` is what the field ends up holding and what `title.js` builds a title from —
 * "T-Shirts", never the whole trail. `choiceLabel` is what a user picks between, and there
 * the path is the only thing that tells the two T-Shirts apart.
 */
const valueLabel = c => c.title ?? c.label ?? String(c.id);
const choiceLabel = c => c.path || c.title || c.label || String(c.id);

/**
 * Every candidate whose title equals `label` after normalisation. Returns a LIST, because
 * finding two is a real answer that must not be collapsed into one.
 *
 * `splitOn` exists for sizes: Vinted writes "M / 38 / 10" and the label on the garment
 * says "M". Without splitting nothing would ever match; with it, any of the systems in
 * the title does. It is off by default — a brand named "Nike / Jordan" must not match
 * "Jordan".
 */
export function exactMatch(label, candidates, { splitOn = null } = {}) {
  const wanted = normaliseLabel(label);
  if (!wanted) return [];

  return (candidates || []).filter(c => {
    const title = c?.title ?? c?.label ?? '';
    if (normaliseLabel(title) === wanted) return true;
    if (!splitOn) return false;
    return String(title).split(splitOn).some(part => normaliseLabel(part) === wanted);
  });
}

/**
 * The candidate with this id, or null.
 *
 * This is the gate the model's choice passes through. Ids are compared as strings because
 * a model answering with "53" means the same thing as 53 — but membership in the list is
 * not negotiable.
 */
export function validatePick(pickedId, candidates) {
  if (pickedId == null) return null;
  return (candidates || []).find(c => String(c?.id) === String(pickedId)) || null;
}

/**
 * Resolve one field against its candidate list.
 *
 * Returns `{ id, label, confidence, candidates, source, needsPick, rejectedPick }` — the
 * shape `draft-view.js` renders. `candidates` is non-empty only when there is a genuine
 * choice to present; `needsPick` says the narrow second model call would earn its keep
 * here, and nowhere else.
 */
export function resolveField({ label, candidates = [], pick = null, splitOn = null } = {}) {
  const base = { label: label ?? null, id: null, confidence: 0, candidates: [], source: 'unresolved', needsPick: false, rejectedPick: false };

  // An explicit pick is a decision — but only if it names something real.
  if (pick != null) {
    const picked = validatePick(pick, candidates);
    if (picked) {
      return { ...base, id: picked.id, label: valueLabel(picked), confidence: 1, source: 'pick' };
    }
    base.rejectedPick = true; // fall through to matching; never fall through to a guess
  }

  const hits = exactMatch(label, candidates, { splitOn });
  if (hits.length === 1) {
    return { ...base, id: hits[0].id, label: valueLabel(hits[0]), confidence: 1, source: 'exact' };
  }
  if (hits.length > 1) {
    return {
      ...base,
      candidates: hits.map(c => ({ id: c.id, label: choiceLabel(c) })),
      source: 'ambiguous',
      needsPick: true
    };
  }
  return base;
}

/**
 * The order the fields must be resolved in. Not a preference — a dependency: the size set
 * is only defined once the category is, and the price range needs category, brand and
 * condition together (measured in the 0b spike: an incomplete query is answered empty).
 */
export function resolveOrder() {
  return ['category', 'brand', 'color', 'size', 'condition', 'price'];
}

/**
 * Compare our resolution with Vinted's own suggestion.
 *
 * Three outcomes, and the middle one is why this exists:
 *  - we agree, or Vinted said nothing → the resolution stands
 *  - we found nothing and Vinted is unambiguous → we adopt it (this is the whole benefit
 *    of Vinted resolving for us: it hands back real ids, not strings)
 *  - we disagree → the field is emptied and BOTH answers are offered. Quietly keeping
 *    ours is exactly how an article ends up in the wrong category.
 *
 * `suggestion` is `{ ids, candidates }` — the ids Vinted returned plus the list they can
 * be looked up in. An id we have no candidate for is ignored rather than displayed as a
 * bare number.
 */
export function crossCheck(resolution, suggestion) {
  const ids = suggestion?.ids || [];
  const known = ids.map(id => validatePick(id, suggestion?.candidates)).filter(Boolean);
  if (!known.length) return { ...resolution, agreed: true };

  if (resolution.id != null) {
    const agreed = known.some(c => String(c.id) === String(resolution.id));
    if (agreed) return { ...resolution, agreed: true };

    const ours = { id: resolution.id, label: resolution.label };
    const theirs = known.map(c => ({ id: c.id, label: choiceLabel(c) })).filter(c => String(c.id) !== String(ours.id));
    return { ...resolution, id: null, confidence: 0, agreed: false, source: 'conflict', candidates: [ours, ...theirs] };
  }

  // We had nothing. One suggestion settles it; several remain a choice.
  if (known.length === 1) {
    return { ...resolution, id: known[0].id, label: valueLabel(known[0]), confidence: 1, source: 'vinted', agreed: true, candidates: [] };
  }
  return {
    ...resolution,
    agreed: true,
    source: 'vinted',
    candidates: known.map(c => ({ id: c.id, label: choiceLabel(c) }))
  };
}
