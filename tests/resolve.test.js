import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseLabel, exactMatch, validatePick, resolveField, resolveOrder, crossCheck
} from '../lib/resolve.js';

const BRANDS = [
  { id: 53, title: 'Nike' },
  { id: 14, title: 'adidas' },
  { id: 787, title: 'Ellesse' }
];

/** Two categories whose titles differ only by their path — the classic ambiguity. */
const CATEGORIES = [
  { id: 1807, title: 'T-Shirts', path: 'Herren > Kleidung > T-Shirts' },
  { id: 221, title: 'T-Shirts', path: 'Damen > Kleidung > T-Shirts' },
  { id: 196, title: 'Hoodies & Sweaters', path: 'Damen > Kleidung > Hoodies & Sweaters' }
];

/** Vinted's size titles carry several systems at once. */
const SIZES = [
  { id: 102, title: 'XXS / 32 / 4' },
  { id: 103, title: 'XS / 34 / 6' },
  { id: 105, title: 'M / 38 / 10' }
];

// ---------- normalisation ----------

test('normaliseLabel: case, spacing and diacritics do not decide a match', () => {
  assert.equal(normaliseLabel('  NIKE '), normaliseLabel('nike'));
  assert.equal(normaliseLabel('Größe'), normaliseLabel('Grosse'));
  assert.equal(normaliseLabel('T-Shirts'), normaliseLabel('t shirts'));
  assert.equal(normaliseLabel('Hoodies  &  Sweaters'), normaliseLabel('hoodies & sweaters'));
});

test('normaliseLabel: survives what the model might not send', () => {
  assert.equal(normaliseLabel(null), '');
  assert.equal(normaliseLabel(undefined), '');
  assert.equal(normaliseLabel(42), '42');
});

// ---------- exactMatch ----------

test('exactMatch: finds the one candidate, ignoring spelling noise', () => {
  assert.deepEqual(exactMatch('  nike ', BRANDS), [{ id: 53, title: 'Nike' }]);
});

test('exactMatch: returns every equally good candidate, it does not pick', () => {
  const hits = exactMatch('T-Shirts', CATEGORIES);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(h => h.id).sort((a, b) => a - b), [221, 1807]);
});

test('exactMatch: no hit is an empty list, never a near miss', () => {
  assert.deepEqual(exactMatch('Nikee', BRANDS), []);
  assert.deepEqual(exactMatch('', BRANDS), []);
  assert.deepEqual(exactMatch('Nike', []), []);
  assert.deepEqual(exactMatch('Nike', null), []);
});

test('exactMatch: a size matches any system inside the title', () => {
  // Vinted writes "M / 38 / 10"; the label says "M". Without splitting, nothing matches.
  assert.deepEqual(exactMatch('M', SIZES, { splitOn: '/' }), [{ id: 105, title: 'M / 38 / 10' }]);
  assert.deepEqual(exactMatch('38', SIZES, { splitOn: '/' }), [{ id: 105, title: 'M / 38 / 10' }]);
  assert.deepEqual(exactMatch('XS', SIZES, { splitOn: '/' }), [{ id: 103, title: 'XS / 34 / 6' }]);
});

test('exactMatch: without splitting, a size label does not accidentally match', () => {
  assert.deepEqual(exactMatch('M', SIZES), []);
});

// ---------- validatePick ----------

test('validatePick: an id from the list comes back', () => {
  assert.deepEqual(validatePick(53, BRANDS), { id: 53, title: 'Nike' });
});

test('validatePick: an id that was NOT in the list is discarded — this is the invariant', () => {
  assert.equal(validatePick(999, BRANDS), null);
  assert.equal(validatePick(null, BRANDS), null);
  assert.equal(validatePick(53, []), null);
});

test('validatePick: a numeric id sent as a string is still the same id', () => {
  assert.deepEqual(validatePick('53', BRANDS), { id: 53, title: 'Nike' });
});

// ---------- resolveField ----------

test('resolveField: a direct hit resolves without anyone being asked', () => {
  const r = resolveField({ label: 'Nike', candidates: BRANDS });
  assert.equal(r.id, 53);
  assert.equal(r.label, 'Nike');
  assert.equal(r.confidence, 1);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.source, 'exact');
  assert.equal(r.needsPick, false, 'a direct hit must not trigger a second model call');
});

test('resolveField: two equally good candidates are an ambiguity, not a coin toss', () => {
  const r = resolveField({ label: 'T-Shirts', candidates: CATEGORIES });
  assert.equal(r.id, null);
  assert.equal(r.confidence, 0);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.source, 'ambiguous');
  assert.equal(r.needsPick, true, 'this is where the narrow second call earns its keep');
});

test('resolveField: an unknown label resolves to nothing at all', () => {
  const r = resolveField({ label: 'Nikee', candidates: BRANDS });
  assert.equal(r.id, null);
  assert.equal(r.source, 'unresolved');
  assert.deepEqual(r.candidates, [], 'no candidates means nothing to choose between');
});

test('resolveField: a missing label is not an error, just unresolved', () => {
  const r = resolveField({ label: null, candidates: BRANDS });
  assert.equal(r.id, null);
  assert.equal(r.source, 'unresolved');
});

test('resolveField: a valid pick from the model settles an ambiguity', () => {
  const r = resolveField({ label: 'T-Shirts', candidates: CATEGORIES, pick: 1807 });
  assert.equal(r.id, 1807);
  assert.equal(r.label, 'T-Shirts');
  assert.equal(r.source, 'pick');
  assert.equal(r.needsPick, false);
});

test('resolveField: an invented id is rejected and the field stays open', () => {
  // The whole point of ADR-0005: the model chooses FROM the list, it does not produce ids.
  const r = resolveField({ label: 'T-Shirts', candidates: CATEGORIES, pick: 4711 });
  assert.equal(r.id, null);
  assert.equal(r.rejectedPick, true);
  assert.equal(r.candidates.length, 2, 'it falls back to the ambiguity, not to a guess');
});

test('resolveField: a pick cannot override a direct hit with something else', () => {
  const r = resolveField({ label: 'Nike', candidates: BRANDS, pick: 14 });
  assert.equal(r.id, 14, 'an explicit pick is a decision and wins');
  assert.equal(r.source, 'pick');
});

test('resolveField: the candidate list is carried as {id,label} for the studio', () => {
  const r = resolveField({ label: 'T-Shirts', candidates: CATEGORIES });
  for (const c of r.candidates) {
    assert.equal(typeof c.id, 'number');
    assert.equal(typeof c.label, 'string');
    assert.ok(c.label.length);
  }
});

test('resolveField: a category candidate shows its path, so the two T-Shirts are distinguishable', () => {
  const r = resolveField({ label: 'T-Shirts', candidates: CATEGORIES });
  assert.ok(r.candidates.every(c => /Herren|Damen/.test(c.label)), JSON.stringify(r.candidates));
});

test('resolveField: sizes are matched with splitting, brands are not', () => {
  const size = resolveField({ label: 'M', candidates: SIZES, splitOn: '/' });
  assert.equal(size.id, 105);
  const brand = resolveField({ label: 'M', candidates: BRANDS });
  assert.equal(brand.id, null);
});

// ---------- order ----------

test('resolveOrder: the category comes before the size — the size set hangs off it', () => {
  const order = resolveOrder();
  assert.ok(order.indexOf('category') < order.indexOf('size'), order.join(' → '));
});

test('resolveOrder: the brand comes before the price — the range needs the brand id', () => {
  const order = resolveOrder();
  assert.ok(order.indexOf('brand') < order.indexOf('price'), order.join(' → '));
});

test('resolveOrder: every field appears exactly once', () => {
  const order = resolveOrder();
  assert.equal(new Set(order).size, order.length);
});

// ---------- cross-check against Vinted's own suggestion ----------

test('crossCheck: agreement leaves the resolution untouched', () => {
  const ours = resolveField({ label: 'Hoodies & Sweaters', candidates: CATEGORIES });
  const checked = crossCheck(ours, { ids: [196], candidates: CATEGORIES });
  assert.equal(checked.id, 196);
  assert.equal(checked.agreed, true);
  assert.deepEqual(checked.candidates, []);
});

test('crossCheck: our answer among several suggestions still counts as agreement', () => {
  const ours = resolveField({ label: 'T-Shirts', candidates: CATEGORIES, pick: 1807 });
  const checked = crossCheck(ours, { ids: [1807, 221], candidates: CATEGORIES });
  assert.equal(checked.agreed, true);
  assert.equal(checked.id, 1807);
});

test('crossCheck: a disagreement blocks the field and shows both answers', () => {
  // Ours says Hoodies, Vinted's photo recognition says T-Shirts. One of them is wrong,
  // and quietly keeping ours is how a wrongly filed article happens.
  const ours = resolveField({ label: 'Hoodies & Sweaters', candidates: CATEGORIES });
  const checked = crossCheck(ours, { ids: [1807], candidates: CATEGORIES });
  assert.equal(checked.agreed, false);
  assert.equal(checked.id, null);
  assert.equal(checked.candidates.length, 2);
  assert.deepEqual(checked.candidates.map(c => c.id).sort((a, b) => a - b), [196, 1807]);
});

test('crossCheck: no suggestion from Vinted means nothing to check against', () => {
  const ours = resolveField({ label: 'Nike', candidates: BRANDS });
  for (const suggestion of [null, undefined, { ids: [] }, {}]) {
    const checked = crossCheck(ours, suggestion);
    assert.equal(checked.id, 53, JSON.stringify(suggestion));
    assert.equal(checked.agreed, true);
  }
});

test('crossCheck: an unresolved field adopts Vinted\'s suggestion when it is unambiguous', () => {
  const ours = resolveField({ label: 'Ellesse Sport', candidates: BRANDS });
  assert.equal(ours.id, null);
  const checked = crossCheck(ours, { ids: [787], candidates: BRANDS });
  assert.equal(checked.id, 787, 'Vinted resolved what we could not — that is the point of C');
  assert.equal(checked.source, 'vinted');
});

test('crossCheck: an unresolved field with several suggestions stays a choice', () => {
  const ours = resolveField({ label: 'Shirt', candidates: CATEGORIES });
  const checked = crossCheck(ours, { ids: [1807, 221], candidates: CATEGORIES });
  assert.equal(checked.id, null);
  assert.equal(checked.candidates.length, 2);
});

test('crossCheck: a suggested id we have no candidate for is ignored, not invented', () => {
  const ours = resolveField({ label: 'Nike', candidates: BRANDS });
  const checked = crossCheck(ours, { ids: [99999], candidates: BRANDS });
  assert.equal(checked.id, 53, 'an unknown suggestion cannot unseat a direct hit');
  assert.equal(checked.agreed, true);
});

// ---------- das Etikett trägt genauso oft mehrere Systeme wie Vinteds Liste ----------

test('exactMatch: „MD/M/M" vom Etikett trifft „M / 38 / 10"', () => {
  // Der echte Fehlschlag vom 2026-08-23. `splitOn` zerlegte nur Vinteds Titel, nie das
  // Gelesene — als Ganzes ist „MD/M/M" nie eine Vinted-Größe, und der Create scheiterte
  // nach dem Foto-Upload an `size: Wähle ein Größe`.
  const sizes = [
    { id: 104, title: 'S / 36 / 8' },
    { id: 105, title: 'M / 38 / 10' },
    { id: 106, title: 'L / 40 / 12' }
  ];
  const hits = exactMatch('MD/M/M', sizes, { splitOn: '/' });
  assert.deepEqual(hits.map(h => h.id), [105]);
});

test('exactMatch: „38/40" trifft beides und ist damit eine Auswahl, keine Entscheidung', () => {
  const sizes = [{ id: 105, title: 'M / 38 / 10' }, { id: 106, title: 'L / 40 / 12' }];
  const hits = exactMatch('38/40', sizes, { splitOn: '/' });
  assert.deepEqual(hits.map(h => h.id), [105, 106]);
  assert.equal(resolveField({ label: '38/40', candidates: sizes, splitOn: '/' }).id, null);
});

test('exactMatch: ohne splitOn wird nichts zerlegt — auch das Gelesene nicht', () => {
  // Der Grund, warum das nur für Größen gilt: eine Marke „Nike / Jordan" darf nicht auf
  // „Jordan" passen, und ein getipptes „Nike/Adidas" erst recht nicht auf beide.
  const brands = [{ id: 1, title: 'Nike' }, { id: 2, title: 'Jordan' }];
  assert.deepEqual(exactMatch('Nike/Jordan', brands), []);
});
