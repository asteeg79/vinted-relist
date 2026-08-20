import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_STEP, roundPrice, belowFloor, midpoint, priceForDraft } from '../lib/price.js';

/** A parsed suggestion as taxonomy.js hands it over. */
const range = (over = {}) => ({ min: 4, max: 9, midpoint: 6, price: 8, currency: 'EUR', grounded: true, ...over });

// ---------- rounding ----------

test('roundPrice: rounds commercially to whole 50 cents', () => {
  assert.equal(roundPrice(6.0), 6.0);
  assert.equal(roundPrice(6.24), 6.0);
  assert.equal(roundPrice(6.25), 6.5);
  assert.equal(roundPrice(6.74), 6.5);
  assert.equal(roundPrice(6.75), 7.0);
});

test('roundPrice: no floating point dust in a price', () => {
  // 0.1 + 0.2 arithmetic must not reach a listing as 6.500000000000001.
  for (const v of [1.1, 2.3, 6.7, 19.99, 0.7]) {
    const r = roundPrice(v);
    assert.equal(r, Number(r.toFixed(2)), `${v} → ${r}`);
  }
});

test('roundPrice: nonsense in, null out', () => {
  assert.equal(roundPrice(null), null);
  assert.equal(roundPrice('teuer'), null);
  assert.equal(roundPrice(NaN), null);
  assert.equal(roundPrice(-3), null);
});

// ---------- the floor ----------

test('belowFloor: only when a floor is set and the price undercuts it', () => {
  assert.equal(belowFloor(8, 20), true);
  assert.equal(belowFloor(20, 20), false);
  assert.equal(belowFloor(25, 20), false);
});

test('belowFloor: a floor of 0 is off — the default must never block', () => {
  assert.equal(belowFloor(3, 0), false);
  assert.equal(belowFloor(3, null), false);
  assert.equal(belowFloor(3, undefined), false);
});

test('belowFloor: no price cannot undercut anything', () => {
  assert.equal(belowFloor(null, 20), false);
  assert.equal(belowFloor(undefined, 20), false);
});

// ---------- midpoint ----------

test('midpoint: takes Vinted\'s number, it does not average the range itself', () => {
  // (4+9)/2 is 6.50. Vinted says 6.00, and Vinted has the sales data.
  assert.equal(midpoint(range()), 6);
});

test('midpoint: rounds what Vinted sends', () => {
  assert.equal(midpoint(range({ midpoint: 6.3 })), 6.5);
  assert.equal(midpoint(range({ midpoint: 17 })), 17);
});

test('midpoint: min === max is a valid range', () => {
  assert.equal(midpoint(range({ min: 5, max: 5, midpoint: 5 })), 5);
});

test('midpoint: no range means no price — never an estimate', () => {
  assert.equal(midpoint(null), null);
  assert.equal(midpoint(undefined), null);
  assert.equal(midpoint({ grounded: false, midpoint: 6 }), null);
  assert.equal(midpoint({ grounded: true }), null);
});

// ---------- priceForDraft (Entscheidung W3) ----------

test('priceForDraft: a fresh range becomes the proposed price', () => {
  const p = priceForDraft(null, range());
  assert.equal(p.value, 6);
  assert.equal(p.source, 'range');
  assert.deepEqual(p.range, { min: 4, max: 9 });
});

test('priceForDraft: a new range replaces an older one — the condition moved it', () => {
  // Measured in the spike: the same article at "Zufriedenstellend" is 11–23 € instead of 4–9 €.
  const before = priceForDraft(null, range());
  const after = priceForDraft(before, range({ min: 11, max: 23, midpoint: 17 }));
  assert.equal(after.value, 17);
  assert.equal(after.source, 'range');
});

test('priceForDraft: a price the user typed survives a reloaded range', () => {
  const manual = { value: 31, source: 'manual' };
  const p = priceForDraft(manual, range({ min: 11, max: 23, midpoint: 17 }));
  assert.equal(p.value, 31, 'overwriting what the user decided is the bug W3 is about');
  assert.equal(p.source, 'manual');
});

test('priceForDraft: the superseded suggestion is kept visible, not silently dropped', () => {
  const p = priceForDraft({ value: 31, source: 'manual' }, range({ midpoint: 17 }));
  assert.equal(p.supersededBy, 17, 'the studio can show what Vinted would have proposed');
});

test('priceForDraft: no range and no manual price is no price at all', () => {
  assert.equal(priceForDraft(null, null), null);
  assert.equal(priceForDraft(null, { grounded: false }), null);
});

test('priceForDraft: a manual price stands even when the range disappears', () => {
  const p = priceForDraft({ value: 31, source: 'manual' }, null);
  assert.equal(p.value, 31);
  assert.equal(p.source, 'manual');
  assert.equal(p.supersededBy, null);
});

test('priceForDraft: an earlier range without a new one is dropped, not frozen', () => {
  // The category changed and there are no comparable sales any more — showing the old
  // number would be a price for a different article.
  const before = priceForDraft(null, range());
  assert.equal(priceForDraft(before, null), null);
});

test('priceForDraft: a manual price of nothing is not a manual price', () => {
  const p = priceForDraft({ value: null, source: 'manual' }, range());
  assert.equal(p.value, 6);
  assert.equal(p.source, 'range');
});
