import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOFT_MAX, HARD_MAX, PROFILES, buildTitle, missingRequired, profileFor
} from '../lib/title.js';

const byteLength = s => new TextEncoder().encode(s).length;

// ---------- the schema ----------

test('buildTitle: clothing renders Marke · Art · Größe · Farbe in that order', () => {
  const t = buildTitle({ brand: 'Nike', type: 'Hoodie', size: 'M', color: 'Schwarz' });
  assert.equal(t, 'Nike Hoodie M Schwarz');
});

test('buildTitle: slot order is the profile order, not the object order', () => {
  const t = buildTitle({ color: 'Schwarz', size: 'M', type: 'Hoodie', brand: 'Nike' });
  assert.equal(t, 'Nike Hoodie M Schwarz');
});

test('buildTitle: media uses its own slots', () => {
  const t = buildTitle({ work: 'Dune', author: 'Herbert', format: 'Taschenbuch' }, PROFILES.media);
  assert.equal(t, 'Dune Herbert Taschenbuch');
});

test('buildTitle: missing slots produce no double spaces and no stray edges', () => {
  const t = buildTitle({ brand: 'Nike', size: 'M' });
  assert.equal(t, 'Nike M');
  assert.ok(!/\s{2}/.test(t) && t === t.trim());
});

test('buildTitle: empty fields are treated as absent', () => {
  const t = buildTitle({ brand: 'Nike', type: 'Hoodie', size: 'M', color: '   ' });
  assert.equal(t, 'Nike Hoodie M');
});

test('buildTitle: no fields at all yields an empty string, not "undefined"', () => {
  assert.equal(buildTitle({}), '');
});

// ---------- shortening ----------

test('buildTitle: shortening drops the colour first and keeps brand/type/size', () => {
  const t = buildTitle({
    brand: 'Tommy Hilfiger Denim Collection',
    type: 'Strickpullover mit Rundhalsausschnitt',
    size: 'XL',
    color: 'Dunkelblau meliert'
  });
  assert.ok(!t.includes('Dunkelblau'), `colour survived: ${t}`);
  assert.ok(t.includes('Tommy Hilfiger') && t.includes('Strickpullover') && t.includes('XL'));
});

test('buildTitle: accessories drop material before colour', () => {
  const fields = {
    brand: 'Michael Kors Collection Selma',
    type: 'Umhängetasche mit Kettenriemen',
    color: 'Cognacbraun',
    material: 'Sattelleder'
  };
  const t = buildTitle(fields, PROFILES.accessories);
  assert.ok(!t.includes('Sattelleder'), `material survived: ${t}`);
});

test('buildTitle: required slots survive even when they alone exceed SOFT_MAX', () => {
  const t = buildTitle({
    brand: 'Ein außergewöhnlich langer Markenname für Testzwecke',
    type: 'Kapuzensweatshirt',
    size: 'M',
    color: 'Rot'
  });
  assert.ok(t.length > SOFT_MAX, 'this case is only interesting above the soft limit');
  assert.ok(t.includes('Kapuzensweatshirt') && t.includes('M'));
});

test('buildTitle: does not pad short titles up to SOFT_MAX', () => {
  const t = buildTitle({ brand: 'Nike', type: 'Hoodie', size: 'M', color: 'Schwarz' });
  assert.equal(t.length, 21);
});

// ---------- the hard limit ----------

test('buildTitle: never returns more than HARD_MAX, even with absurd input', () => {
  const t = buildTitle({
    brand: 'Marke '.repeat(30).trim(),
    type: 'Kapuzenpullover '.repeat(10).trim(),
    size: 'XXL',
    color: 'Mitternachtsblau'
  });
  assert.ok(t.length <= HARD_MAX, `${t.length} chars: ${t}`);
  assert.ok(byteLength(t) <= HARD_MAX, `${byteLength(t)} bytes`);
});

test('buildTitle: the emergency brake cuts at a word boundary', () => {
  const t = buildTitle({
    brand: 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike',
    type: 'November Oscar Papa Quebec Romeo Sierra Tango',
    size: 'M'
  });
  assert.ok(t.length <= HARD_MAX);
  assert.ok(!t.endsWith(' '));
  // Every word in the result is a whole word from the input.
  const words = new Set(('Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike '
    + 'November Oscar Papa Quebec Romeo Sierra Tango M').split(' '));
  for (const w of t.split(' ')) assert.ok(words.has(w), `"${w}" is a fragment, not a word`);
});

test('buildTitle: umlauts count against the byte length', () => {
  // 100 chars but 130 bytes if only characters were counted.
  const t = buildTitle({ brand: 'Ä'.repeat(60), type: 'Ö'.repeat(60), size: 'M' });
  assert.ok(byteLength(t) <= HARD_MAX, `${byteLength(t)} bytes: ${t}`);
});

test('buildTitle: a single unbreakable word is still cut to the limit', () => {
  const t = buildTitle({ brand: 'X'.repeat(300), type: '', size: '' });
  assert.ok(t.length <= HARD_MAX && t.length > 0);
});

test('buildTitle: limits are overridable per call', () => {
  const t = buildTitle({ brand: 'Nike', type: 'Hoodie', size: 'M', color: 'Schwarz' }, PROFILES.clothing, { softMax: 12 });
  assert.equal(t, 'Nike Hoodie M');
});

// ---------- required fields ----------

test('missingRequired: clothing without a size is blocked', () => {
  assert.deepEqual(missingRequired({ brand: 'Nike', type: 'Hoodie' }, PROFILES.clothing), ['size']);
});

test('missingRequired: media without a size is fine', () => {
  assert.deepEqual(missingRequired({ work: 'Dune' }, PROFILES.media), []);
});

test('missingRequired: reports every missing required slot', () => {
  assert.deepEqual(missingRequired({}, PROFILES.clothing), ['brand', 'type', 'size']);
});

test('missingRequired: a blank string counts as missing', () => {
  assert.deepEqual(missingRequired({ brand: 'Nike', type: 'Hoodie', size: '  ' }, PROFILES.clothing), ['size']);
});

test('missingRequired: generic only demands the type', () => {
  assert.deepEqual(missingRequired({ type: 'Lampe' }, PROFILES.generic), []);
});

// ---------- profile choice ----------

test('profileFor: maps the category group from the analysis', () => {
  assert.equal(profileFor('clothing'), PROFILES.clothing);
  assert.equal(profileFor('shoes'), PROFILES.shoes);
  assert.equal(profileFor('media'), PROFILES.media);
});

test('profileFor: an unknown or missing group falls back to generic, never throws', () => {
  assert.equal(profileFor('haushaltsgeraete'), PROFILES.generic);
  assert.equal(profileFor(null), PROFILES.generic);
  assert.equal(profileFor(undefined), PROFILES.generic);
});

test('every profile: required slots are a subset of its slots and never dropped', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    for (const r of p.required) assert.ok(p.slots.includes(r), `${name}: required "${r}" is not a slot`);
    for (const d of p.dropOrder) {
      assert.ok(p.slots.includes(d), `${name}: dropOrder "${d}" is not a slot`);
      assert.ok(!p.required.includes(d), `${name}: dropOrder "${d}" is required`);
    }
  }
});
