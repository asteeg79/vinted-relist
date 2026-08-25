import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { setProgress, clearProgress } from '../lib/progress.js';
import { RELIST_STEPS } from '../lib/steps.js';

let ctx;
beforeEach(() => { ctx = installChromeMock(); });

test('setProgress: rounds pct and stores step', async () => {
  await setProgress(42.7, 'Foto laden…');
  assert.equal(ctx.store.progress.pct, 43);
  assert.equal(ctx.store.progress.step, 'Foto laden…');
  assert.ok(ctx.store.progress.ts > 0);
});

test('setProgress: ohne Phasentabelle bleibt die Liste leer', async () => {
  await setProgress(50, 'x');
  assert.deepEqual(ctx.store.progress.steps, []);
});

test('setProgress: Balken und Phasenliste kommen aus DERSELBEN gerundeten Zahl', async () => {
  // 74,6 rundet auf 75 — und 75 ist genau die Marke, ab der „Neuen Artikel erstellen"
  // läuft. Vorher bekam `stepsAt` das ungerundete 74,6 und führte noch „Fotos übertragen"
  // als laufend: der Balken saß auf der Grenze, die Liste stand eine Phase davor.
  await setProgress(74.6, 'Foto 4/4: hochladen…', RELIST_STEPS);
  const { pct, steps } = ctx.store.progress;

  assert.equal(pct, 75);
  assert.equal(steps.find(s => s.state === 'current').label, 'Neuen Artikel erstellen');
  assert.equal(steps.filter(s => s.state === 'current').length, 1, 'immer genau eine läuft');
});

test('clearProgress: removes the key', async () => {
  await setProgress(10, 'x');
  await clearProgress();
  assert.equal(ctx.store.progress, undefined);
});
