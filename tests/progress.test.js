import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { setProgress, clearProgress } from '../lib/progress.js';

let ctx;
beforeEach(() => { ctx = installChromeMock(); });

test('setProgress: rounds pct and stores step', async () => {
  await setProgress(42.7, 'Foto laden…');
  assert.equal(ctx.store.progress.pct, 43);
  assert.equal(ctx.store.progress.step, 'Foto laden…');
  assert.ok(ctx.store.progress.ts > 0);
});

test('clearProgress: removes the key', async () => {
  await setProgress(10, 'x');
  await clearProgress();
  assert.equal(ctx.store.progress, undefined);
});
