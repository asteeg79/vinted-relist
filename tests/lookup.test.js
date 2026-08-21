import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupDraft, applySuggestions } from '../lib/lookup.js';

const CATALOGS = [
  { id: 5, title: 'Herren', path: 'Herren', isLeaf: false },
  { id: 10, title: 'Kleidung', path: 'Herren > Kleidung', isLeaf: false },
  { id: 1807, title: 'T-Shirts', path: 'Herren > Kleidung > T-Shirts', isLeaf: true },
  { id: 196, title: 'Hoodies & Sweaters', path: 'Damen > Kleidung > Hoodies & Sweaters', isLeaf: true }
];
const BRANDS = [{ id: 53, title: 'Nike' }, { id: 787, title: 'Ellesse' }];
const COLORS = [{ id: 27, title: 'Marineblau' }, { id: 1, title: 'Schwarz' }];
const SIZES = [{ id: 105, title: 'M / 38 / 10' }, { id: 102, title: 'XXS / 32 / 4' }];
/** Vinted's own ids and wording, as measured on 2026-08-20. "Sehr gut" is 2, not 3. */
const CONDITIONS = [
  { id: 6, title: 'Neu, mit Etikett', explanation: 'mit Etikett' },
  { id: 1, title: 'Neu', explanation: 'ohne Etikett' },
  { id: 2, title: 'Sehr gut', explanation: 'selten benutzt' },
  { id: 3, title: 'Gut', explanation: 'benutzt' }
];
/** The general list carries one stage the upload list does not offer. */
const STATUSES = [...CONDITIONS, { id: 7, title: 'Nicht voll funktionsfähig', explanation: null }];

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
    statuses: record('statuses', STATUSES),
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
  // The condition is the one exception, and on purpose: it does not hang off the category,
  // and an empty greyed-out select is what made the studio look broken.
  assert.deepEqual(
    taxonomy.asked.map(a => a.name).filter(n => n !== 'catalogs'),
    ['statuses']
  );
});

test('lookupDraft: an unresolved category still offers a condition to choose', async () => {
  const r = await lookupDraft({
    analysis: analysis({ type: 'Gibtsnicht' }),
    taxonomy: fakeTaxonomy(),
    settings: { draftConditionDefault: 'very_good' }
  });
  assert.deepEqual(r.conditions, STATUSES);
  assert.equal(r.condition.id, 2, 'the default is placed even without a category');
  assert.equal(r.condition.source, 'default');
});

test('lookupDraft: a failing status list is empty, never a made-up stage', async () => {
  const taxonomy = fakeTaxonomy({ statuses: async () => { throw new Error('403'); } });
  const r = await lookupDraft({ analysis: analysis({ type: 'Gibtsnicht' }), taxonomy });
  assert.deepEqual(r.conditions, []);
  assert.equal(r.condition.id, null);
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

test('lookupDraft: the model\'s reading is taken when it was sure enough', async () => {
  const r = await lookupDraft({
    analysis: analysis({ condition: 'good', condition_confidence: 0.9, condition_evidence: 'Pilling an den Ärmeln' }),
    taxonomy: fakeTaxonomy(),
    settings: { draftConditionDefault: 'very_good', draftConfidenceThreshold: 0.8 }
  });
  assert.equal(r.condition.id, 3, 'Gut, not the configured Sehr gut');
  assert.equal(r.condition.source, 'ai');
  assert.equal(r.condition.evidence, 'Pilling an den Ärmeln');
});

test('lookupDraft: an unsure reading falls back to the configured default', async () => {
  const r = await lookupDraft({
    analysis: analysis({ condition: 'good', condition_confidence: 0.4 }),
    taxonomy: fakeTaxonomy(),
    settings: { draftConditionDefault: 'very_good', draftConfidenceThreshold: 0.8 }
  });
  assert.equal(r.condition.id, 2);
  assert.equal(r.condition.source, 'default');
});

test('lookupDraft: the condition is decided BEFORE the price is asked for', async () => {
  // Order, not taste: the range needs status_id, and an incomplete query comes back empty.
  // Choosing the condition afterwards is why no suggestion ever appeared on the first pass.
  const taxonomy = fakeTaxonomy();
  await lookupDraft({
    analysis: analysis({ condition: 'good', condition_confidence: 0.95 }),
    taxonomy,
    settings: { draftConditionDefault: 'very_good' }
  });
  const price = taxonomy.asked.find(a => a.name === 'priceSuggestion');
  assert.equal(price.args[0].statusId, 3, 'the price was asked with a real status, not null');
});

test('lookupDraft: a condition the user chose survives the next lookup', async () => {
  const r = await lookupDraft({
    analysis: analysis({ condition: 'good', condition_confidence: 0.99 }),
    taxonomy: fakeTaxonomy(),
    condition: 6,
    settings: {}
  });
  assert.equal(r.condition.id, 6, 'the model does not overrule a person');
  assert.equal(r.condition.source, 'user');
});

test('lookupDraft: a condition the current list no longer offers is dropped', async () => {
  // 7 rides in /api/v2/statuses but not in the upload list. Carrying it along would be
  // rejected at create time with a message nobody can act on.
  const r = await lookupDraft({
    analysis: analysis(), taxonomy: fakeTaxonomy(), condition: 7,
    settings: { draftConditionDefault: 'very_good' }
  });
  assert.equal(r.condition.id, 2);
  assert.notEqual(r.condition.source, 'user');
});

test('lookupDraft: conditions come from Vinted, with their own ids and explanations', async () => {
  const r = await lookupDraft({ analysis: analysis(), taxonomy: fakeTaxonomy(), condition: 2 });
  assert.deepEqual(r.conditions, CONDITIONS);
});

// ---------- the size that was read but does not fit ----------

test('lookupDraft: a size Vinted does not know is said out loud, not swallowed', async () => {
  const r = await lookupDraft({
    analysis: analysis({ size_label: '52 Kurzgröße' }), taxonomy: fakeTaxonomy(), condition: 2
  });
  assert.equal(r.resolved.size.id, null);
  assert.ok(r.warnings.some(w => /52 Kurzgröße/.test(w)), r.warnings.join(' | '));
});

test('lookupDraft: no size on any photo is not the same complaint', async () => {
  const r = await lookupDraft({
    analysis: analysis({ size_label: null }), taxonomy: fakeTaxonomy(), condition: 2
  });
  assert.equal(r.resolved.size.id, null);
  assert.equal(r.warnings.length, 0, 'nothing to say — the field simply blocks');
});

// ---------- Vinteds eigene Kategoriesuche als Rückfallebene ----------

test('lookupDraft: a type Vinted spells differently is found through its own search', async () => {
  // The model says "Hoodie", the leaf is called "Hoodies & Sweaters". Exact equality is a
  // narrow door; Vinted searches its own tree far better than we can guess its wording.
  const taxonomy = fakeTaxonomy({ searchCatalogs: async () => [196] });
  const r = await lookupDraft({ analysis: analysis({ type: 'Hoodie' }), taxonomy, condition: 2 });
  assert.equal(r.resolved.catalog.id, 196);
  assert.equal(r.resolved.catalog.label, 'Hoodies & Sweaters', 'Vinteds wording, not ours');
  assert.equal(r.resolved.catalog.source, 'search');
  assert.ok(r.resolved.catalog.confidence < 0.8, 'found, not verified — it must be confirmed');
  assert.ok(r.warnings.some(w => /Suche/.test(w)), r.warnings.join(' | '));
});

test('lookupDraft: the search only runs when the exact match found nothing', async () => {
  let asked = 0;
  const taxonomy = fakeTaxonomy({ searchCatalogs: async () => { asked++; return [1807]; } });
  await lookupDraft({ analysis: analysis(), taxonomy, condition: 2 }); // "Hoodies & Sweaters" hits exactly
  assert.equal(asked, 0, 'an exact hit needs no search');
});

test('lookupDraft: a pick outranks the search — a person has already decided', async () => {
  let asked = 0;
  const taxonomy = fakeTaxonomy({ searchCatalogs: async () => { asked++; return [196]; } });
  const r = await lookupDraft({
    analysis: analysis({ type: 'Hoodie' }), taxonomy, picks: { category: 1807 }, condition: 2
  });
  assert.equal(r.resolved.catalog.id, 1807);
  assert.equal(asked, 0);
});

test('lookupDraft: several search hits are a choice, never a ranking', async () => {
  const taxonomy = fakeTaxonomy({ searchCatalogs: async () => [1807, 196] });
  const r = await lookupDraft({ analysis: analysis({ type: 'Hoodie' }), taxonomy });
  assert.equal(r.resolved.catalog.id, null, '"Herren" or "Damen" is not ours to decide');
  assert.equal(r.resolved.catalog.candidates.length, 2);
  assert.equal(r.resolved.catalog.needsPick, true);
  assert.match(r.resolved.catalog.candidates[0].label, /Herren/, 'the path is what tells them apart');
});

test('lookupDraft: the search never offers an inner node — you cannot list in "Kleidung"', async () => {
  const taxonomy = fakeTaxonomy({ searchCatalogs: async () => [10, 5] }); // both non-leaves
  const r = await lookupDraft({ analysis: analysis({ type: 'Hoodie' }), taxonomy });
  assert.equal(r.resolved.catalog.id, null);
  assert.equal(r.resolved.catalog.candidates.length, 0);
});

test('lookupDraft: a failing search is simply no answer, never a failed draft', async () => {
  const taxonomy = fakeTaxonomy({ searchCatalogs: async () => { throw new Error('403'); } });
  const r = await lookupDraft({ analysis: analysis({ type: 'Hoodie' }), taxonomy });
  assert.equal(r.resolved.catalog.id, null);
  assert.ok(r.warnings.some(w => /Kategorie/.test(w)));
});

test('lookupDraft: a taxonomy without the search member is fine — nothing throws', async () => {
  const taxonomy = fakeTaxonomy();
  delete taxonomy.searchCatalogs;
  const r = await lookupDraft({ analysis: analysis({ type: 'Hoodie' }), taxonomy });
  assert.equal(r.resolved.catalog.id, null);
});

// ---------- the typed category ----------

test('lookupDraft: what the user typed beats what the model called it', async () => {
  // Without this the category field was decorative: retyping it changed the text and
  // nothing else, and an unresolvable draft had no way out at all.
  const taxonomy = fakeTaxonomy();
  const r = await lookupDraft({
    analysis: analysis({ type: 'Kapuzenpulli' }), taxonomy, condition: 2,
    labels: { category: 'Hoodies & Sweaters' }
  });
  assert.equal(r.resolved.catalog.id, 196);
  assert.equal(r.resolved.catalog.source, 'exact');
});

test('lookupDraft: an empty or blank typed label falls back to the model\'s word', async () => {
  const taxonomy = fakeTaxonomy();
  for (const category of ['', '   ', null, undefined]) {
    const r = await lookupDraft({ analysis: analysis(), taxonomy, condition: 2, labels: { category } });
    assert.equal(r.resolved.catalog.id, 196, JSON.stringify(category));
  }
});

test('lookupDraft: the typed label also drives the search fallback', async () => {
  const seen = [];
  const taxonomy = fakeTaxonomy({ searchCatalogs: async keyword => { seen.push(keyword); return [1807]; } });
  await lookupDraft({
    analysis: analysis({ type: 'Kapuzenpulli' }), taxonomy, labels: { category: 'Sweatshirt' }, condition: 2
  });
  assert.deepEqual(seen, ['Sweatshirt'], 'the model\'s word must not be searched instead');
});
