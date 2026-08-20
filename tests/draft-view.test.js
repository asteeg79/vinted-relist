import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_OK, FIELD_NEEDS_CONFIRMATION, FIELD_MISSING, draftView
} from '../lib/draft-view.js';
import { memoryKey, rememberPrice } from '../lib/price-memory.js';
import { PROFILES, buildTitle } from '../lib/title.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';

/** A confidently recognised hoodie — every slot filled, everything above the threshold. */
function analysis(overrides = {}) {
  return {
    brand: 'Nike',
    brand_confidence: 0.95,
    type: 'Hoodie',
    type_confidence: 0.97,
    size_label: 'M',
    size_source: 'label_photo',
    category_group: 'clothing',
    colors: ['Schwarz'],
    material: 'Baumwolle',
    description_sentence: 'Ein schlichter Hoodie.',
    description_facts: [
      { label: 'Material', value: 'Baumwolle' },
      { label: 'Passform', value: 'gerade' }
    ],
    photo_order: [
      { index: 1, role: 'Gesamtansicht vorn', cropped_off: false },
      { index: 0, role: 'Etikett', cropped_off: false }
    ],
    notes: [],
    ...overrides
  };
}

/** The state of one field by key. */
const state = (view, key) => view.fields.find(f => f.key === key)?.state;
const field = (view, key) => view.fields.find(f => f.key === key);

/** Everything a draft needs to be publishable: price set, condition confirmed. */
function ready(overrides = {}) {
  return {
    analysis: analysis(),
    settings: DEFAULT_SETTINGS,
    price: { value: 18, source: 'range' },
    condition: 2,
    confirmations: { condition: true },
    photos: [{ touchesEdge: false }, { touchesEdge: false }],
    ...overrides
  };
}

// ---------- field states ----------

test('draftView: a confident, complete draft has every field ok', () => {
  const view = draftView(ready());
  for (const f of view.fields) {
    assert.equal(f.state, FIELD_OK, `${f.key} is ${f.state}: ${JSON.stringify(f)}`);
  }
  assert.equal(view.canPublish, true);
  assert.deepEqual(view.blockers, []);
});

test('draftView: a field below the confidence threshold needs confirmation', () => {
  const view = draftView(ready({ analysis: analysis({ brand_confidence: 0.5 }) }));
  assert.equal(state(view, 'brand'), FIELD_NEEDS_CONFIRMATION);
  assert.equal(view.canPublish, false);
});

test('draftView: confirming that field releases it — and only it', () => {
  const base = ready({ analysis: analysis({ brand_confidence: 0.5, type_confidence: 0.4 }) });
  const view = draftView({ ...base, confirmations: { ...base.confirmations, brand: true } });
  assert.equal(state(view, 'brand'), FIELD_OK);
  assert.equal(state(view, 'category'), FIELD_NEEDS_CONFIRMATION);
  assert.equal(view.canPublish, false);
});

test('draftView: the threshold is the configured one, not a constant', () => {
  const base = ready({ analysis: analysis({ brand_confidence: 0.85 }) });
  assert.equal(state(draftView(base), 'brand'), FIELD_OK);
  const strict = draftView({ ...base, settings: { ...DEFAULT_SETTINGS, draftConfidenceThreshold: 0.9 } });
  assert.equal(state(strict, 'brand'), FIELD_NEEDS_CONFIRMATION);
});

test('draftView: a missing required field is missing, not merely unconfirmed', () => {
  const view = draftView(ready({ analysis: analysis({ size_label: null, size_source: 'none' }) }));
  assert.equal(state(view, 'size'), FIELD_MISSING);
  assert.equal(view.canPublish, false);
  assert.ok(view.blockers.some(b => /Größe/.test(b)), view.blockers.join(' | '));
});

test('draftView: a size read off the label is trusted, an estimated one is not', () => {
  const read = draftView(ready({ analysis: analysis({ size_source: 'label_photo' }) }));
  assert.equal(state(read, 'size'), FIELD_OK);
  const guessed = draftView(ready({ analysis: analysis({ size_source: 'estimated' }) }));
  assert.equal(state(guessed, 'size'), FIELD_NEEDS_CONFIRMATION);
});

test('draftView: an optional field left empty does not block', () => {
  // Material is optional even where it is shown; a missing one must not stop publishing.
  const view = draftView(ready({
    analysis: analysis({ category_group: 'accessories', material: null, size_label: null, size_source: 'none' })
  }));
  assert.equal(state(view, 'material'), FIELD_OK);
  assert.equal(view.canPublish, true);
});

test('draftView: two equally good candidates are an ambiguity, not a pick', () => {
  const view = draftView(ready({
    resolved: { catalog: { label: 'Hoodie', confidence: 0.99, candidates: [{ id: 1, label: 'Hoodies' }, { id: 2, label: 'Sweatshirts' }] } }
  }));
  const f = field(view, 'category');
  assert.equal(f.state, FIELD_NEEDS_CONFIRMATION);
  assert.equal(f.candidates.length, 2);
  assert.equal(view.canPublish, false);
});

test('draftView: a resolved id and label win over the raw string from the model', () => {
  const view = draftView(ready({
    resolved: { brand: { id: 53, label: 'Nike Sportswear', confidence: 0.99, candidates: [] } }
  }));
  const f = field(view, 'brand');
  assert.equal(f.value, 'Nike Sportswear');
  assert.equal(f.id, 53);
  assert.equal(f.state, FIELD_OK);
});

test('draftView: a value the user typed counts as confirmed', () => {
  const view = draftView(ready({
    analysis: analysis({ brand: null, brand_confidence: 0 }),
    overrides: { brand: 'Tommy Hilfiger' }
  }));
  const f = field(view, 'brand');
  assert.equal(f.value, 'Tommy Hilfiger');
  assert.equal(f.state, FIELD_OK);
});

// ---------- the pre-set condition ----------

test('draftView: the pre-set condition counts as unconfirmed until it is confirmed', () => {
  const view = draftView(ready({ confirmations: {} }));
  const f = field(view, 'condition');
  assert.equal(f.value, 2, 'the value is Vinted\'s status id, not our symbolic default');
  assert.equal(f.state, FIELD_NEEDS_CONFIRMATION);
  assert.equal(view.canPublish, false, 'a pre-selection must never publish itself');
  assert.ok(view.blockers.some(b => /Zustand/.test(b)));
});

test('draftView: even a condition the user picked has to be confirmed', () => {
  const view = draftView(ready({ condition: 6, confirmations: {} }));
  assert.equal(field(view, 'condition').value, 6);
  assert.equal(field(view, 'condition').state, FIELD_NEEDS_CONFIRMATION);
});

// ---------- price ----------

test('draftView: no price range means no price — never an estimate', () => {
  const view = draftView(ready({ price: null }));
  const f = field(view, 'price');
  assert.equal(f.value, null);
  assert.equal(f.state, FIELD_MISSING);
  assert.equal(view.canPublish, false);
});

test('draftView: a price is a normal ok field once it exists', () => {
  const view = draftView(ready({ price: { value: 24.5, source: 'manual' } }));
  assert.equal(field(view, 'price').value, 24.5);
  assert.equal(field(view, 'price').state, FIELD_OK);
});

test('draftView: a typed price is taken — as a number, not the string from the input', () => {
  const view = draftView(ready({ price: null, overrides: { price: '24,50' } }));
  assert.equal(field(view, 'price').value, 24.5);
  assert.equal(field(view, 'price').state, FIELD_OK);
  assert.equal(view.canPublish, true);
});

test('draftView: a typed price overrides the fetched range', () => {
  const view = draftView(ready({ price: { value: 18, source: 'range' }, overrides: { price: '31' } }));
  assert.equal(field(view, 'price').value, 31);
});

test('draftView: nonsense in the price field is no price', () => {
  for (const typed of ['', 'teuer', '-5', '0']) {
    const view = draftView(ready({ price: null, overrides: { price: typed } }));
    assert.equal(field(view, 'price').value, null, `"${typed}" was taken as a price`);
    assert.equal(field(view, 'price').state, FIELD_MISSING);
  }
});

test('draftView: a price under the configured floor has to be confirmed', () => {
  const settings = { ...DEFAULT_SETTINGS, draftMinPrice: 20 };
  const low = draftView(ready({ settings, price: { value: 8, source: 'range' } }));
  assert.equal(field(low, 'price').state, FIELD_NEEDS_CONFIRMATION);
  assert.match(field(low, 'price').note, /Untergrenze/);
  assert.ok(low.blockers.some(b => /Untergrenze/.test(b)), low.blockers.join(' | '));
  assert.equal(low.canPublish, false);

  const ok = draftView(ready({ settings, price: { value: 20, source: 'range' } }));
  assert.equal(field(ok, 'price').state, FIELD_OK);
  assert.equal(field(ok, 'price').note, null);
});

test('draftView: the floor is off at 0 — the default must not block anything', () => {
  const view = draftView(ready({ price: { value: 3, source: 'manual' } }));
  assert.equal(field(view, 'price').state, FIELD_OK);
});

test('draftView: confirming a price under the floor releases it', () => {
  const base = ready({ settings: { ...DEFAULT_SETTINGS, draftMinPrice: 20 }, price: { value: 8, source: 'range' } });
  const view = draftView({ ...base, confirmations: { ...base.confirmations, price: true } });
  assert.equal(field(view, 'price').state, FIELD_OK);
  assert.equal(view.canPublish, true);
});

// ---------- canPublish ----------

test('draftView: canPublish stays false while anything is unconfirmed, even with nothing missing', () => {
  const view = draftView(ready({ analysis: analysis({ type_confidence: 0.3 }) }));
  assert.ok(view.fields.every(f => f.state !== FIELD_MISSING), 'nothing should be missing here');
  assert.equal(view.canPublish, false);
});

test('draftView: blockers name every open field, not just the first', () => {
  const view = draftView(ready({
    analysis: analysis({ size_label: null, size_source: 'none', brand_confidence: 0.2 }),
    confirmations: {},
    price: null
  }));
  assert.ok(view.blockers.length >= 4, view.blockers.join(' | '));
  assert.equal(view.canPublish, false);
});

test('draftView: without an analysis nothing crashes and nothing is publishable', () => {
  const view = draftView({ settings: DEFAULT_SETTINGS });
  assert.equal(view.canPublish, false);
  assert.ok(view.fields.length);
  assert.equal(view.title, '');
});

test('draftView: survives being called with no arguments at all', () => {
  const view = draftView();
  assert.equal(view.canPublish, false);
  assert.ok(Array.isArray(view.photos));
});

// ---------- title ----------

test('draftView: the title is buildTitle with the profile from the category group', () => {
  const view = draftView(ready());
  assert.equal(view.profile, 'clothing');
  assert.equal(view.title, buildTitle(
    { brand: 'Nike', type: 'Hoodie', size: 'M', color: 'Schwarz' }, PROFILES.clothing
  ));
  assert.equal(view.title, 'Nike Hoodie M Schwarz');
});

test('draftView: another category group selects another profile', () => {
  const view = draftView(ready({
    analysis: analysis({ category_group: 'accessories', type: 'Umhängetasche', size_label: null, size_source: 'none' })
  }));
  assert.equal(view.profile, 'accessories');
  assert.ok(!view.title.includes('M '), view.title);
  assert.ok(view.title.includes('Umhängetasche'));
});

test('draftView: an unknown category group falls back to generic', () => {
  const view = draftView(ready({ analysis: analysis({ category_group: 'moebel' }) }));
  assert.equal(view.profile, 'generic');
});

test('draftView: the title follows the confirmed value, not the model\'s original', () => {
  const view = draftView(ready({ overrides: { brand: 'Adidas' } }));
  assert.ok(view.title.startsWith('Adidas'), view.title);
});

// ---------- photos ----------

test('draftView: photos follow the suggested order, the first one is the cover', () => {
  const view = draftView(ready());
  assert.deepEqual(view.photos.map(p => p.index), [1, 0]);
  assert.equal(view.photos[0].isCover, true);
  assert.equal(view.photos[1].isCover, false);
  assert.equal(view.photos[0].role, 'Gesamtansicht vorn');
});

test('draftView: a cropped-off photo is marked but does not block', () => {
  const view = draftView(ready({
    analysis: analysis({
      photo_order: [
        { index: 0, role: 'Vorderseite', cropped_off: true },
        { index: 1, role: 'Etikett', cropped_off: false }
      ]
    })
  }));
  assert.ok(view.photos[0].warning, 'the finding must be visible');
  assert.equal(view.photos[1].warning, null);
  assert.equal(view.canPublish, true, 'a photo warning is not a blocker');
});

test('draftView: before the model has looked, the heuristic gets a note — not an alarm', () => {
  const view = draftView(ready({ photos: [{ touchesEdge: true }, { touchesEdge: false }] }));
  const noted = view.photos.find(p => p.index === 0);
  assert.equal(noted.warningLevel, 'note');
  assert.ok(noted.warning);
  assert.equal(view.canPublish, true);
});

test('draftView: once the model has judged a photo, its verdict outranks the heuristic', () => {
  // The peel stops at a shadow just as reliably as at a clipped sleeve, so a judged photo
  // with cropped_off: false must not keep carrying the heuristic's edge note.
  const view = draftView(ready({
    photos: [{ touchesEdge: true, judged: true }, { touchesEdge: true, judged: true }]
  }));
  assert.deepEqual(view.photos.map(p => p.warning), [null, null]);
});

test('draftView: a judged photo the model DID find cut off still warns', () => {
  const view = draftView(ready({
    analysis: analysis({
      photo_order: [
        { index: 0, role: 'Vorderseite', cropped_off: true },
        { index: 1, role: 'Etikett', cropped_off: false }
      ]
    }),
    photos: [{ touchesEdge: false, judged: true }, { touchesEdge: false, judged: true }]
  }));
  assert.equal(view.photos[0].warningLevel, 'warn');
  assert.equal(view.photos[1].warning, null);
});

test('draftView: each photo reports how it was processed and at what size', () => {
  const view = draftView(ready({
    photos: [
      { touchesEdge: false, judged: true, mode: 'pad', width: 1080, height: 1350 },
      { touchesEdge: false, judged: true, mode: 'crop', width: 1080, height: 1350 }
    ]
  }));
  const first = view.photos.find(p => p.index === 0);
  assert.equal(first.mode, 'pad');
  assert.equal(first.width, 1080);
  assert.equal(first.height, 1350);
});

test('draftView: photos the model forgot to order still show up, once each', () => {
  const view = draftView(ready({
    analysis: analysis({ photo_order: [{ index: 1, role: 'Vorderseite', cropped_off: false }] }),
    photos: [{ touchesEdge: false }, { touchesEdge: false }, { touchesEdge: false }]
  }));
  assert.equal(view.photos.length, 3);
  assert.deepEqual([...new Set(view.photos.map(p => p.index))].sort(), [0, 1, 2]);
});

test('draftView: an out-of-range index from the model is dropped, not rendered', () => {
  const view = draftView(ready({
    analysis: analysis({
      photo_order: [
        { index: 9, role: 'Geisterfoto', cropped_off: false },
        { index: 0, role: 'Vorderseite', cropped_off: false }
      ]
    })
  }));
  assert.ok(view.photos.every(p => p.index >= 0 && p.index < 2), JSON.stringify(view.photos));
});

// ---------- description ----------

test('draftView: the description is the sentence plus the facts as lines', () => {
  const view = draftView(ready());
  assert.equal(view.description, 'Ein schlichter Hoodie.\n\u2022 Material: Baumwolle\n\u2022 Passform: gerade');
});

test('draftView: an empty description blocks, without being a row of its own', () => {
  const empty = draftView(ready({
    analysis: analysis({ description_sentence: '', description_facts: [] })
  }));
  assert.equal(empty.descriptionState, FIELD_MISSING);
  assert.ok(empty.blockers.some(b => /Beschreibung/.test(b)), empty.blockers.join(' | '));
  assert.equal(empty.canPublish, false);
});

test('draftView: the description is not a field row — it has its own text area', () => {
  const view = draftView(ready());
  assert.equal(state(view, 'description'), undefined, 'the duplicate row is gone');
  assert.equal(view.descriptionState, FIELD_OK);
});

// ---------- price memory ----------

test('draftView: with no price set, what you charged last time is offered', () => {
  const key = memoryKey({ categoryGroup: 'clothing', brand: 'Nike', type: 'Hoodie' });
  const view = draftView(ready({ price: null, priceMemory: rememberPrice({}, key, 18) }));
  assert.equal(view.priceHint.price, 18);
  assert.equal(view.priceHint.match, 'exact');
  assert.equal(view.priceKey, key);
});

test('draftView: the hint is a hint — it never becomes the price by itself', () => {
  const key = memoryKey({ categoryGroup: 'clothing', brand: 'Nike', type: 'Hoodie' });
  const view = draftView(ready({ price: null, priceMemory: rememberPrice({}, key, 18) }));
  assert.equal(field(view, 'price').value, null);
  assert.equal(field(view, 'price').state, FIELD_MISSING);
  assert.equal(view.canPublish, false);
});

test('draftView: once a price is set the hint steps aside', () => {
  const key = memoryKey({ categoryGroup: 'clothing', brand: 'Nike', type: 'Hoodie' });
  const view = draftView(ready({ priceMemory: rememberPrice({}, key, 18) }));
  assert.equal(view.priceHint, null);
});

test('draftView: no history, no hint — nothing is invented', () => {
  const view = draftView(ready({ price: null }));
  assert.equal(view.priceHint, null);
  assert.equal(field(view, 'price').value, null);
});

test('draftView: the key follows a corrected brand, so the right history is found', () => {
  const nike = draftView(ready({ price: null }));
  const adidas = draftView(ready({ price: null, overrides: { brand: 'Adidas' } }));
  assert.notEqual(nike.priceKey, adidas.priceKey);
  assert.match(adidas.priceKey, /adidas/);
});

test('draftView: correcting a field pulls the matching fact along', () => {
  const view = draftView(ready({ overrides: { material: 'Wolle' } }));
  // The form knows "Material" only where the profile shows it — accessories here.
  const acc = draftView(ready({
    analysis: analysis({ category_group: 'accessories', size_label: null, size_source: 'none' }),
    overrides: { material: 'Wolle' }
  }));
  assert.ok(acc.description.includes('\u2022 Material: Wolle'), acc.description);
  assert.ok(!acc.description.includes('Baumwolle'), acc.description);
  // A fact the form does not track keeps the model's value.
  assert.ok(view.description.includes('\u2022 Passform: gerade'), view.description);
});

test('draftView: a fact naming an untracked label survives untouched', () => {
  const view = draftView(ready({
    analysis: analysis({ description_facts: [{ label: 'Besonderheit', value: 'Kapuze' }] })
  }));
  assert.ok(view.description.includes('\u2022 Besonderheit: Kapuze'), view.description);
});

test('draftView: a fact whose value went empty is dropped, not left dangling', () => {
  const view = draftView(ready({
    analysis: analysis({ description_facts: [{ label: 'Material', value: '' }] })
  }));
  assert.equal(view.description, 'Ein schlichter Hoodie.');
});

test('draftView: a description the user rewrote wins and is not recomposed under them', () => {
  const view = draftView(ready({
    overrides: { description: 'Von Hand geschrieben.', material: 'Wolle' }
  }));
  assert.equal(view.description, 'Von Hand geschrieben.');
  assert.equal(view.descriptionState, FIELD_OK);
});

// ---------- shape ----------

test('draftView: every field carries a label the studio can render without deciding', () => {
  for (const f of draftView(ready()).fields) {
    assert.equal(typeof f.key, 'string');
    assert.equal(typeof f.label, 'string');
    assert.ok(f.label.length, `${f.key} has no label`);
    assert.ok([FIELD_OK, FIELD_NEEDS_CONFIRMATION, FIELD_MISSING].includes(f.state));
    assert.ok(Array.isArray(f.candidates));
  }
});

test('draftView: without a condition the field is missing, not silently defaulted', () => {
  // The settings hold a preference, not a status_id. Turning one into the other is
  // lookup.preselectCondition's job, and only once Vinted's list is known.
  const view = draftView(ready({ condition: null, confirmations: {} }));
  assert.equal(field(view, 'condition').value, null);
  assert.equal(state(view, 'condition'), FIELD_MISSING);
});
