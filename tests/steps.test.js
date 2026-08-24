import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELIST_STEPS, DRAFT_STEPS, stepsAt, STEP_DONE, STEP_CURRENT, STEP_TODO } from '../lib/steps.js';

/** Kurzform: die Zustände als Zeichenkette, damit ein Vergleich lesbar bleibt. */
const shape = (steps, pct) => stepsAt(steps, pct).map(s => s.state[0]).join('');

test('stepsAt: am Anfang läuft die erste Phase, alles andere steht aus', () => {
  assert.equal(shape(RELIST_STEPS, 0), 'cttttt');
  assert.equal(shape(RELIST_STEPS, 5), 'cttttt');
});

test('stepsAt: erledigt ist eine Phase erst, wenn die NÄCHSTE begonnen hat', () => {
  // Sonst stünde die laufende Phase als erledigt da, während sie gerade arbeitet: bei 20 %
  // fangen die Fotos an, also ist „Artikeldaten laden" fertig und „Fotos übertragen" dran.
  assert.equal(shape(RELIST_STEPS, 20), 'ddcttt');
  assert.equal(shape(RELIST_STEPS, 74), 'ddcttt', 'die Fotos laufen bis 75');
  assert.equal(shape(RELIST_STEPS, 75), 'dddctt');
});

test('stepsAt: bei 100 % ist alles erledigt und nichts mehr aktuell', () => {
  const done = stepsAt(RELIST_STEPS, 100);
  assert.ok(done.every(s => s.state === STEP_DONE));
  assert.equal(done.some(s => s.state === STEP_CURRENT), false);
});

test('stepsAt: die letzte Phase bleibt aktuell, bis der Lauf fertig meldet', () => {
  // Zwischen „Original löschen" (92) und dem Ende gibt es keine weitere Marke — ohne diese
  // Regel fiele die Phase in „steht aus" zurück.
  assert.equal(shape(RELIST_STEPS, 95), STEP_DONE[0].repeat(5) + STEP_CURRENT[0]);
});

test('stepsAt: die Beschriftungen kommen mit, in der Reihenfolge der Liste', () => {
  assert.deepEqual(stepsAt(RELIST_STEPS, 0).map(s => s.label), RELIST_STEPS.map(s => s.label));
});

test('stepsAt: Unsinn ergibt keine Liste und keinen Absturz', () => {
  assert.deepEqual(stepsAt(null, 50), []);
  assert.deepEqual(stepsAt(undefined, undefined), []);
  assert.equal(shape(RELIST_STEPS, NaN), 'cttttt', 'ohne Zahl steht der Lauf am Anfang');
});

test('beide Listen sind aufsteigend — sonst trüge die Prozentzahl keine Reihenfolge', () => {
  for (const [name, steps] of [['relist', RELIST_STEPS], ['draft', DRAFT_STEPS]]) {
    for (let i = 1; i < steps.length; i++) {
      assert.ok(steps[i].at > steps[i - 1].at, `${name}: ${steps[i].label} liegt nicht nach ${steps[i - 1].label}`);
    }
    assert.equal(steps[0].at, 0, `${name}: die erste Phase beginnt bei 0`);
    assert.ok(steps.every(s => s.label && s.at < 100), `${name}: jede Phase hat eine Beschriftung und beginnt vor 100`);
  }
});

test('DRAFT_STEPS folgt den Marken, die draft.js wirklich meldet', () => {
  // 15 = Fotos, 80 = Payload, 90 = Create. Läuft eine Marke weg, zeigt die Liste die
  // falsche Phase als aktuell an — und niemand merkt es, weil nichts scheitert.
  assert.equal(shape(DRAFT_STEPS, 15), 'dcttt');
  assert.equal(shape(DRAFT_STEPS, 80), 'dddct');
  assert.equal(shape(DRAFT_STEPS, 90), 'ddddc');
});
