/**
 * Der Preis eines Drafts.
 *
 * WHAT THE SPIKE CHANGED. The concept planned to compute the middle of Vinted's range
 * ourselves (§7.4: `runde(min + (max - min) / 2)`). Measuring the endpoint showed that
 * Vinted already sends a `midpoint` — and that it is NOT the arithmetic mean: for a 4–9 €
 * range it says 6.00, not 6.50. That number comes out of their sales data, so it is taken
 * as given. Averaging it ourselves would be replacing a measurement with a guess.
 *
 * WHAT DID NOT CHANGE. No range, no price. There is no fallback estimate anywhere in this
 * file: a wrong price on a public listing is a real loss, and a missing one merely blocks
 * publishing until someone types a number.
 *
 * Pure: no chrome.*, no DOM, no I/O.
 */

/** Vinted's own prices land on whole 50 cents, and so do ours. */
export const PRICE_STEP = 0.5;

/**
 * Commercial rounding onto the step, in cents, so no floating-point dust reaches a
 * listing — `6.5000000000000001 €` is the kind of detail buyers notice and sellers can't
 * explain. Anything that is not a positive, finite number is not a price.
 */
export function roundPrice(value, step = PRICE_STEP) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  const stepCents = Math.round(step * 100);
  return Math.round(cents / stepCents) * stepCents / 100;
}

/**
 * Does this price undercut the user's own floor?
 *
 * The floor exists against one specific failure: a wrong category yields a wrong range,
 * and a branded piece goes out at t-shirt money. It deliberately does NOT raise the price
 * — silently correcting it upward would hide exactly the signal it exists to produce.
 * `draft-view.js` turns a true here into a confirmation the user has to give.
 */
export function belowFloor(value, floor) {
  if (!floor || floor <= 0) return false;
  return value != null && value < floor;
}

/**
 * Vinted's proposed price for a range, rounded — or null.
 *
 * `grounded` is their `similar_sold_items_present`: false means there are no comparable
 * sales, and then there is no proposal at all (KONZEPT §7.4).
 */
export function midpoint(suggestion) {
  if (!suggestion?.grounded) return null;
  return roundPrice(suggestion.midpoint);
}

/**
 * The draft's price after a range arrives or is refetched (Entscheidung W3).
 *
 * A range is refetched whenever the condition changes, and the condition moves it a lot —
 * the same article measured at "Sehr gut" and "Zufriedenstellend" came back as 4–9 € and
 * 11–23 €. So the proposal has to follow the condition. What must NOT follow it is a price
 * the user typed: that is a decision, it stands, and the proposal it displaced is kept in
 * `supersededBy` so the studio can show it rather than swallow it.
 */
export function priceForDraft(current, suggestion) {
  const proposed = midpoint(suggestion);

  if (current?.source === 'manual' && current.value != null) {
    return { ...current, supersededBy: proposed };
  }
  if (proposed == null) return null;

  return {
    value: proposed,
    source: 'range',
    range: { min: suggestion.min, max: suggestion.max },
    supersededBy: null
  };
}
