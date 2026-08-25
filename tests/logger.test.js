import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { log, clearLog } from '../lib/logger.js';

let ctx;
beforeEach(() => { ctx = installChromeMock(); });

test('log: appends a timestamped, serialized line', async () => {
  await log('photo_uploaded', { i: 0, id: 123 });
  const lines = ctx.store.log;
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[.*\] photo_uploaded \{"i":0,"id":123\}$/);
});

test('log: keeps at most 500 lines (ring buffer)', async () => {
  installChromeMock({ log: Array.from({ length: 499 }, (_, i) => `old${i}`) });
  await log('e1');
  await log('e2');
  const { log: out } = await chrome.storage.local.get('log');
  assert.equal(out.length, 500);            // capped
  assert.match(out[out.length - 1], /e2/);  // newest kept
  assert.equal(out[0], 'old1');             // oldest ('old0') dropped
});

test('clearLog: empties the log', async () => {
  await log('x');
  await clearLog();
  const { log: out } = await chrome.storage.local.get('log');
  assert.deepEqual(out, []);
});

test('log: wirft nie — auch nicht, wenn der Speicher nicht mehr will', async () => {
  // `log` steht an über dreißig Stellen, mehrere davon in catch-Blöcken, deren einzige
  // Aufgabe es ist, Vinteds feldweise Auskunft zu retten. Ein `await` auf eine abgelehnte
  // Log-Zeile wirft dort AUS DEM catch heraus, und beim Nutzer kommt ein Speicherfehler an
  // statt „isbn: Bitte gib eine ISBN an". Der Preis ist ausgesprochen: ein kaputtes Log
  // schweigt. Ein Log, das den Lauf abbricht, den es beschreiben soll, wäre schlimmer.
  chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  await log('publish_failed', { error: 'egal' });
});

test('log: auch ein zyklisches Datenobjekt bringt den Lauf nicht zu Fall', async () => {
  // Die zweite Sorte Fehler an dieser Stelle: `JSON.stringify` wirft an einem Zyklus. Das
  // passiert nicht mit Absicht, sondern indem jemand `{ error: e }` statt `e.message` loggt.
  const zyklisch = { name: 'a' };
  zyklisch.self = zyklisch;
  await log('publish_failed', zyklisch);
  assert.deepEqual(ctx.store.log ?? [], [], 'geschrieben wird nichts — geworfen aber auch nicht');
});
