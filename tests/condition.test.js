import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONDITIONS, CONDITION_VALUES, conditionByValue, conditionIdFor, conditionValueFor,
  conditionTitleFor, chooseCondition
} from '../lib/condition.js';

/**
 * Vinteds Antwort, wortgleich gemessen am 2026-08-20 auf www.vinted.de
 * (`/api/v2/item_upload/conditions?catalog_id=1807`).
 */
const VINTED = [
  { id: 6, title: 'Neu, mit Etikett', explanation: 'Ein brandneuer, unbenutzter Artikel mit Etikett oder original verpackt.' },
  { id: 1, title: 'Neu', explanation: 'Ein brandneuer, unbenutzter Artikel ohne Etikett oder Originalverpackung.' },
  { id: 2, title: 'Sehr gut', explanation: 'Ein nur selten benutzter Artikel …' },
  { id: 3, title: 'Gut', explanation: 'Ein benutzter Artikel …' },
  { id: 4, title: 'Zufriedenstellend', explanation: 'Ein oft benutzter Artikel …' }
];

// ---------- the vocabulary ----------

test('every stage has a symbol, a label, at least one Vinted spelling and a definition', () => {
  assert.equal(CONDITIONS.length, 5);
  for (const c of CONDITIONS) {
    assert.match(c.value, /^[a-z_]+$/);
    assert.ok(c.label.length > 0, c.value);
    assert.ok(c.titles.length > 0, c.value);
    assert.ok(c.definition.length > 20, `${c.value} needs Vinted's own wording for the prompt`);
  }
  assert.equal(new Set(CONDITION_VALUES).size, CONDITION_VALUES.length, 'symbols are unique');
});

test('no two stages claim the same Vinted spelling', () => {
  const all = CONDITIONS.flatMap(c => c.titles);
  assert.equal(new Set(all).size, all.length, 'an overlapping title makes the mapping ambiguous');
});

test('conditionByValue: unknown is null, never a nearest neighbour', () => {
  assert.equal(conditionByValue('very_good').label, 'Sehr gut');
  assert.equal(conditionByValue('bespielt'), null);
  assert.equal(conditionByValue(null), null);
});

// ---------- symbol → Vinted id ----------

test('conditionIdFor: every symbol finds its id in Vinted\'s real answer', () => {
  assert.equal(conditionIdFor(VINTED, 'new_with_tags'), 6);
  assert.equal(conditionIdFor(VINTED, 'new_without_tags'), 1, '"Neu ohne Etikett" is simply "Neu" at Vinted');
  assert.equal(conditionIdFor(VINTED, 'very_good'), 2, 'measured: 2, not 3');
  assert.equal(conditionIdFor(VINTED, 'good'), 3);
  assert.equal(conditionIdFor(VINTED, 'satisfactory'), 4);
});

test('conditionIdFor: the comma in "Neu, mit Etikett" must not decide it', () => {
  // This is the bug the old label match had: our copy said "Neu mit Etikett", Vinted writes
  // "Neu, mit Etikett", and the two stages that differ by a comma never matched.
  assert.equal(conditionIdFor([{ id: 6, title: 'Neu mit Etikett' }], 'new_with_tags'), 6);
  assert.equal(conditionIdFor([{ id: 6, title: 'Neu,  MIT   Etikett' }], 'new_with_tags'), 6);
  assert.equal(conditionIdFor([{ id: 6, title: 'Neu mit Preisschild' }], 'new_with_tags'), 6);
});

test('conditionIdFor: nothing matching means null — never the first entry', () => {
  assert.equal(conditionIdFor(VINTED, 'gibtsnicht'), null);
  assert.equal(conditionIdFor([], 'very_good'), null);
  assert.equal(conditionIdFor(null, 'very_good'), null);
  assert.equal(conditionIdFor(VINTED, null), null);
});

test('conditionValueFor: the way back, for display and the log', () => {
  assert.equal(conditionValueFor(VINTED, 2), 'very_good');
  assert.equal(conditionValueFor(VINTED, '2'), 'very_good', 'a string id means the same thing');
  assert.equal(conditionValueFor(VINTED, 999), null);
  assert.equal(conditionValueFor(VINTED, null), null);
  assert.equal(conditionValueFor([{ id: 9, title: 'Bespielt' }], 9), null, 'a stage we have no symbol for');
});

test('conditionTitleFor: Vinteds own word, so screen and dropdown say the same thing', () => {
  assert.equal(conditionTitleFor(VINTED, 2), 'Sehr gut');
  assert.equal(conditionTitleFor(VINTED, '2'), 'Sehr gut', 'a string id means the same thing');
  // Deliberately Vinteds title, not our label: 'Neu ohne Etikett' is simply 'Neu' there.
  assert.equal(conditionTitleFor(VINTED, 1), 'Neu');
  assert.equal(conditionTitleFor([{ id: 9, title: 'Bespielt' }], 9), 'Bespielt',
    'a stage we have no symbol for is still a word on the screen');
  assert.equal(conditionTitleFor(VINTED, 999), null);
  assert.equal(conditionTitleFor([], 2), null, 'no list yet, no word');
  assert.equal(conditionTitleFor(null, 2), null);
  assert.equal(conditionTitleFor(VINTED, null), null);
});

// ---------- choosing ----------

const sure = (value, confidence = 0.95, evidence = null) =>
  ({ condition: value, condition_confidence: confidence, condition_evidence: evidence });

test('chooseCondition: a confident reading wins over the configured default', () => {
  const c = chooseCondition({
    conditions: VINTED,
    analysis: sure('good', 0.9, 'Pilling an den Ärmeln'),
    settings: { draftConditionDefault: 'very_good', draftConfidenceThreshold: 0.8 }
  });
  assert.deepEqual(c, { id: 3, source: 'ai', value: 'good', evidence: 'Pilling an den Ärmeln' });
});

test('chooseCondition: below the threshold the default is the honest answer', () => {
  // An unsure model answer looks exactly like a sure one in the UI. The default at least
  // announces itself as a default.
  const c = chooseCondition({
    conditions: VINTED,
    analysis: sure('satisfactory', 0.55),
    settings: { draftConditionDefault: 'very_good', draftConfidenceThreshold: 0.8 }
  });
  assert.equal(c.id, 2);
  assert.equal(c.source, 'default');
});

test('chooseCondition: "unknown" is a real answer and falls through to the default', () => {
  const c = chooseCondition({
    conditions: VINTED, analysis: sure('unknown', 0.99), settings: { draftConditionDefault: 'good' }
  });
  assert.equal(c.id, 3);
  assert.equal(c.source, 'default');
});

test('chooseCondition: the threshold defaults to the same 0.8 the other fields use', () => {
  assert.equal(chooseCondition({ conditions: VINTED, analysis: sure('good', 0.79) }).source, 'default');
  assert.equal(chooseCondition({ conditions: VINTED, analysis: sure('good', 0.8) }).source, 'ai');
});

test('chooseCondition: without a settings default it still lands on Sehr gut', () => {
  const c = chooseCondition({ conditions: VINTED });
  assert.equal(c.id, 2);
  assert.equal(c.value, 'very_good');
});

test('chooseCondition: no list means nothing is chosen', () => {
  // The expensive but correct outcome: a condition nobody picked is legally binding (§7.5).
  assert.deepEqual(chooseCondition({ conditions: [], analysis: sure('good') }),
    { id: null, source: null, value: null, evidence: null });
  assert.deepEqual(chooseCondition(), { id: null, source: null, value: null, evidence: null });
});

test('chooseCondition: a list that does not contain the default yields nothing, not a stand-in', () => {
  const odd = [{ id: 99, title: 'Bespielt' }];
  assert.deepEqual(chooseCondition({ conditions: odd, settings: { draftConditionDefault: 'very_good' } }),
    { id: null, source: null, value: null, evidence: null });
});

test('chooseCondition: a confident reading Vinted does not offer falls back, it does not invent', () => {
  const noNew = VINTED.filter(c => c.id !== 6);
  const c = chooseCondition({
    conditions: noNew, analysis: sure('new_with_tags', 0.99), settings: { draftConditionDefault: 'very_good' }
  });
  assert.equal(c.id, 2);
  assert.equal(c.source, 'default');
});

test('chooseCondition: a malformed confidence is not a confidence', () => {
  for (const bad of [undefined, null, '0.9', NaN]) {
    const c = chooseCondition({
      conditions: VINTED,
      analysis: { condition: 'good', condition_confidence: bad },
      settings: { draftConditionDefault: 'very_good' }
    });
    assert.equal(c.source, 'default', String(bad));
  }
});
