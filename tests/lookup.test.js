import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupDraft, applySuggestions, preselectCondition } from '../lib/lookup.js';

const CATALOGS = [
  { id: 5, title: 'Herren', path: 'Herren', isLeaf: false },
  { id: 10, title: 'Kleidung', path: 'Herren > Kleidung', isLeaf: false },
  { id: 1807, title: 'T-Shirts', path: 'Herren > Kleidung > T-Shirts', isLeaf: true },
  { id: 196, title: 'Hoodies & Sweaters', path: 'Damen > Kleidung > Hoodies & Sweaters', isLeaf: true }
];
const BRANDS = [{ id: 53, title: 'Nike' }, { id: 787, title: 'Ellesse' }];
const COLORS = [{ id: 27, title: 'Marineblau' }, { id: 1, title: 'Schwarz' }];
const SIZES = [{ id: 105, title: 'M / 38 / 10' }, { id: 102, title: 'XXS / 32 / 4' }];
const CONDITIONS = [{ id: 1, title: 'Neu mit Etikett' }, { id: 2, title: 'Sehr gut' }];

/** A taxonomy double: answers from constants, records what was asked. */
function fakeTaxonomy(over = {}) {
  const asked = [];
  const record = (name, value) => async (...args) => { asked.push({ name, args }); return value; };
  const t = {
    catalogs: record('catalogs', CATALOGS),
    brands: record('brands', BRANDS),
    colors: record('colors', COLORS),
    sizes: record('sizes', SIZES),
    conditions: record('conditions', CONDITIONS),
    requiredFields: record('requiredFields', ['brand', 'price']),
    priceSuggestion: record('priceSuggestion', { min: 4, max: 9, midpoint: 6, grounded: true }),
    ...over
  };
  t.asked = asked;
  return t;
}

const analysis = (over = {}) => ({
  brand: 'Nike',
  type: 'Hoodies & Sweaters',
  size_label: 'M',
  colors: ['Marineblau'],
  ...over
});

// ---------- the happy path ----------

test('lookupDraft: resolves every field to a Vinted id', async () => {
  const r = await lookupDraft({ analysis: analysis(), taxonomy: fakeTaxonomy(), condition: 2 });
  assert.equal(r.resolved.catalog.id, 196);
  assert.equal(r.resolved.brand.id, 53);
  assert.equal(r.resolved.color.id, 27);
  assert.equal(r.resolved.size.id, 105, 'the label says M, Vinted says "M / 38 / 10"');
  assert.equal(r.price.value, 6);
  assert.deepEqual(r.requiredFields, ['brand', 'price']);
  assert.deepEqual(r.warnings, []);
});

test('lookupDraft: the size set is asked for THIS category, not globally', async () => {
  const taxonomy = fakeTaxonomy();
  await lookupDraft({ analysis: analysis(), taxonomy, condition: 2 });
  const sizes = taxonomy.asked.find(a => a.name === 'sizes');
  assert.deepEqual(sizes.args, [196]);
});

test('lookupDraft: the price is asked with all three ids', async () => {
  const taxonomy = fakeTaxonomy();
  await lookupDraft({ analysis: analysis(), taxonomy, condition: 2 });
  const price = taxonomy.asked.find(a => a.name === 'priceSuggestion');
  assert.deepEqual(price.args[0], { catalogId: 196, brandId: 53, statusId: 2 });
});

test('lookupDraft: inner catalog nodes are never offered — you cannot list in "Kleidung"', async () => {
  const r = await lookupDraft({ analysis: analysis({ type: 'Kleidung' }), taxonomy: fakeTaxonomy() });
  assert.equal(r.resolved.catalog.id, null);
});

// ---------- the dependency ----------

test('lookupDraft: without a category nothing downstream is even attempted', async () => {
  const taxonomy = fakeTaxonomy();
  const r = await lookupDraft({ analysis: analysis({ type: 'Gibtsnicht' }), taxonomy });

  assert.equal(r.resolved.catalog.id, null);
  assert.equal(r.resolved.brand, undefined, 'a brand list needs a category id');
  assert.equal(r.price, null);
  assert.ok(r.warnings.some(w => /Kategorie/.test(w)), r.warnings.join(' | '));
  assert.equal(taxonomy.asked.filter(a => a.name !== 'catalogs').length, 0);
});

test('lookupDraft: an unresolvable brand leaves the price unasked-for, not guessed', async () => {
  const taxonomy = fakeTaxonomy({
    priceSuggestion: async ({ brandId }) => (brandId == null ? null : { min: 4, max: 9, midpoint: 6, grounded: true })
  });
  const r = await lookupDraft({ analysis: analysis({ brand: 'Unbekannt' }), taxonomy, condition: 2 });
  assert.equal(r.resolved.brand.id, null);
  assert.equal(r.price, null);
});

// ---------- ambiguity and picks ----------

test('lookupDraft: an ambiguity comes back as a choice, not a decision', async () => {
  const catalogs = [
    { id: 1807, title: 'T-Shirts', path: 'Herren > Kleidung > T-Shirts', isLeaf: true },
    { id: 221, title: 'T-Shirts', path: 'Damen > Kleidung > T-Shirts', isLeaf: true }
  ];
  const taxonomy = fakeTaxonomy({ catalogs: async () => catalogs });
  const r = await lookupDraft({ analysis: analysis({ type: 'T-Shirts' }), taxonomy });
  assert.equal(r.resolved.catalog.id, null);
  assert.equal(r.resolved.catalog.candidates.length, 2);
  assert.equal(r.resolved.catalog.needsPick, true);
});

test('lookupDraft: a pick settles it and the rest of the chain runs', async () => {
  const catalogs = [
    { id: 1807, title: 'T-Shirts', path: 'Herren > Kleidung > T-Shirts', isLeaf: true },
    { id: 221, title: 'T-Shirts', path: 'Damen > Kleidung > T-Shirts', isLeaf: true }
  ];
  const taxonomy = fakeTaxonomy({ catalogs: async () => catalogs });
  const r = await lookupDraft({
    analysis: analysis({ type: 'T-Shirts' }), taxonomy, picks: { category: 221 }, condition: 2
  });
  assert.equal(r.resolved.catalog.id, 221);
  assert.equal(r.price.value, 6);
});

test('lookupDraft: an invented pick is discarded, the deterministic match still stands', async () => {
  const r = await lookupDraft({ analysis: analysis(), taxonomy: fakeTaxonomy(), picks: { brand: 999999 } });
  assert.equal(r.resolved.brand.rejectedPick, true, 'an id outside the list is never taken');
  assert.equal(r.resolved.brand.id, 53, 'falling back to the exact hit is safe — it is deterministic');
  assert.equal(r.resolved.brand.source, 'exact');
});

test('lookupDraft: an invented pick on an ambiguous field leaves it open', async () => {
  const catalogs = [
    { id: 1807, title: 'T-Shirts', path: 'Herren > Kleidung > T-Shirts', isLeaf: true },
    { id: 221, title: 'T-Shirts', path: 'Damen > Kleidung > T-Shirts', isLeaf: true }
  ];
  const taxonomy = fakeTaxonomy({ catalogs: async () => catalogs });
  const r = await lookupDraft({
    analysis: analysis({ type: 'T-Shirts' }), taxonomy, picks: { category: 4711 }
  });
  assert.equal(r.resolved.catalog.id, null, 'there is nothing deterministic to fall back to');
  assert.equal(r.resolved.catalog.rejectedPick, true);
});

// ---------- the manual price ----------

test('lookupDraft: a price the user typed survives the lookup', async () => {
  const r = await lookupDraft({
    analysis: analysis(), taxonomy: fakeTaxonomy(), condition: 2,
    price: { value: 31, source: 'manual' }
  });
  assert.equal(r.price.value, 31);
  assert.equal(r.price.supersededBy, 6);
});

// ---------- warnings ----------

test('lookupDraft: a brand demanding proof of authenticity is announced beforehand', async () => {
  const taxonomy = fakeTaxonomy({
    brands: async () => [{ id: 53, title: 'Nike', requires_authenticity_check: true }]
  });
  const r = await lookupDraft({ analysis: analysis(), taxonomy, condition: 2 });
  assert.ok(r.warnings.some(w => /Echtheit/i.test(w)), r.warnings.join(' | '));
});

test('lookupDraft: survives being called with nothing at all', async () => {
  const r = await lookupDraft();
  assert.deepEqual(r.resolved, {});
  assert.equal(r.price, null);
  assert.deepEqual(r.warnings, []);
});

test('lookupDraft: conditions come from Vinted, with their own ids', async () => {
  const r = await lookupDraft({ analysis: analysis(), taxonomy: fakeTaxonomy(), condition: 2 });
  assert.deepEqual(r.conditions, CONDITIONS);
});

// ---------- the cross-check (Entscheidung C) ----------

test('applySuggestions: agreement leaves everything as it was', async () => {
  const { resolved } = await lookupDraft({ analysis: analysis(), taxonomy: fakeTaxonomy(), condition: 2 });
  const checked = applySuggestions(resolved, {
    catalog: { ids: [196], candidates: CATALOGS },
    brand: { ids: [53], candidates: BRANDS }
  });
  assert.equal(checked.catalog.id, 196);
  assert.equal(checked.brand.id, 53);
  assert.equal(checked.catalog.agreed, true);
});

test('applySuggestions: a disagreement empties the field and shows both answers', async () => {
  const { resolved } = await lookupDraft({ analysis: analysis(), taxonomy: fakeTaxonomy(), condition: 2 });
  const checked = applySuggestions(resolved, { catalog: { ids: [1807], candidates: CATALOGS } });
  assert.equal(checked.catalog.id, null);
  assert.equal(checked.catalog.agreed, false);
  assert.equal(checked.catalog.candidates.length, 2);
});

test('applySuggestions: a field with no suggestion is untouched', async () => {
  const { resolved } = await lookupDraft({ analysis: analysis(), taxonomy: fakeTaxonomy(), condition: 2 });
  const checked = applySuggestions(resolved, {});
  assert.deepEqual(checked.size, resolved.size);
});

// ---------- the pre-selected condition ----------

test('preselectCondition: places the cursor on the configured default', () => {
  assert.equal(preselectCondition(CONDITIONS, 'Sehr gut'), 2);
  assert.equal(preselectCondition(CONDITIONS, 'sehr  GUT'), 2, 'spelling must not decide it');
});

test('preselectCondition: no match means nothing is pre-selected', () => {
  // Better an empty field the user has to fill than a condition nobody chose — the
  // condition is legally binding (KONZEPT §7.5).
  assert.equal(preselectCondition(CONDITIONS, 'Bespielt'), null);
  assert.equal(preselectCondition([], 'Sehr gut'), null);
  assert.equal(preselectCondition(CONDITIONS, null), null);
  assert.equal(preselectCondition(null, 'Sehr gut'), null);
});
