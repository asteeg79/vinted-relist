import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gatesFor, describeOutcome, describeFailure,
  GATE_FIRST_RUN, GATE_COOLDOWN, GATE_INTEREST, draftGatesFor, describeDraftOutcome, GATE_FIRST_CREATE,
  publishModeNote, publishedNote, resetGateFor } from '../lib/gates.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';

const settings = (patch = {}) => ({ ...DEFAULT_SETTINGS, ...patch });
const quiet = { favourites: 0, views: 0, conversations: 0 };
const cold = { lastHour: 0, last24h: 0 };
const kinds = input => gatesFor(input).map(g => g.kind);

// ====================================================================================
// gatesFor
// ====================================================================================

test('a quiet item on a fresh, already-confirmed install raises no gate', () => {
  assert.deepEqual(gatesFor({ interest: quiet, counts: cold, settings: settings(), confirmedDelete: true }), []);
});

test('gates come back in a fixed order: first-run, cooldown, interest', () => {
  const all = kinds({
    interest: { favourites: 2, views: 10, conversations: 1 },
    counts: { lastHour: 9, last24h: 40 },
    settings: settings(),
    confirmedDelete: false
  });
  assert.deepEqual(all, [GATE_FIRST_RUN, GATE_COOLDOWN, GATE_INTEREST]);
});

test('gatesFor tolerates being called with nothing', () => {
  assert.deepEqual(gatesFor(), []);
});

test('every gate has the full shape a renderer expects', () => {
  const all = gatesFor({
    interest: { favourites: 1 }, counts: { lastHour: 99 }, settings: settings(), confirmedDelete: false
  });
  assert.equal(all.length, 3);
  for (const g of all) {
    assert.equal(typeof g.kind, 'string');
    assert.equal(typeof g.title, 'string');
    assert.equal(typeof g.text, 'string');
    assert.ok(Array.isArray(g.lines), 'lines is always an array');
    assert.equal(typeof g.note, 'string', 'note is always a string');
    assert.equal(typeof g.remember, 'boolean', 'remember is always a boolean');
  }
});

// ---- first-run ----

test('first-run gate appears until the user has confirmed', () => {
  const input = { interest: quiet, counts: cold, settings: settings(), confirmedDelete: false };
  assert.deepEqual(kinds(input), [GATE_FIRST_RUN]);
  assert.deepEqual(kinds({ ...input, confirmedDelete: true }), []);
});

test('first-run gate is skipped in test mode — nothing gets deleted', () => {
  const gates = kinds({
    interest: quiet, counts: cold, settings: settings({ deleteEnabled: false }), confirmedDelete: false
  });
  assert.deepEqual(gates, []);
});

test('first-run gate says the original is permanently deleted', () => {
  const [gate] = gatesFor({ interest: quiet, counts: cold, settings: settings(), confirmedDelete: false });
  assert.match(gate.text, /dauerhaft gelöscht/);
});

// ---- cooldown ----

test('cooldown gate fires at the hourly threshold, not below it', () => {
  const at = { interest: quiet, counts: { lastHour: 5, last24h: 0 }, settings: settings(), confirmedDelete: true };
  assert.deepEqual(kinds(at), [GATE_COOLDOWN]);
  assert.deepEqual(kinds({ ...at, counts: { lastHour: 4, last24h: 0 } }), []);
});

test('cooldown gate fires at the 24h threshold independently', () => {
  const gates = kinds({
    interest: quiet, counts: { lastHour: 0, last24h: 30 }, settings: settings(), confirmedDelete: true
  });
  assert.deepEqual(gates, [GATE_COOLDOWN]);
});

test('cooldown thresholds come from settings', () => {
  const counts = { lastHour: 2, last24h: 0 };
  const base = { interest: quiet, counts, confirmedDelete: true };
  assert.deepEqual(kinds({ ...base, settings: settings({ cooldownWarnPerHour: 2 }) }), [GATE_COOLDOWN]);
  assert.deepEqual(kinds({ ...base, settings: settings({ cooldownWarnPerHour: 3 }) }), []);
});

test('cooldown gate quotes both counts back to the user', () => {
  const [gate] = gatesFor({
    interest: quiet, counts: { lastHour: 7, last24h: 33 }, settings: settings(), confirmedDelete: true
  });
  assert.match(gate.text, /7 Bumps/);
  assert.match(gate.text, /33 in den letzten 24 h/);
});

// ---- interest ----

test('interest gate lists only the non-zero metrics', () => {
  const [gate] = gatesFor({
    interest: { favourites: 3, views: 0, conversations: 2 },
    counts: cold, settings: settings(), confirmedDelete: true
  });
  assert.equal(gate.kind, GATE_INTEREST);
  assert.deepEqual(gate.lines, ['Favoriten: 3', 'Gespräche: 2']);
  assert.match(gate.note, /gehen diese Daten verloren/);
});

test('interest gate stays silent when the item has no engagement', () => {
  assert.deepEqual(kinds({ interest: quiet, counts: cold, settings: settings(), confirmedDelete: true }), []);
});

test('interest gate is suppressed by the interestWarn setting', () => {
  const gates = kinds({
    interest: { favourites: 9, views: 9, conversations: 9 },
    counts: cold, settings: settings({ interestWarn: false }), confirmedDelete: true
  });
  assert.deepEqual(gates, []);
});

test('missing interest fields are treated as zero, not as a warning', () => {
  assert.deepEqual(kinds({ counts: cold, settings: settings(), confirmedDelete: true }), []);
});

test('only the first-run gate asks to be remembered', () => {
  // Both UIs act on `remember` rather than matching on `kind`, so this flag — not a
  // hardcoded gate name — is what decides whether an acceptance is persisted. That
  // matters most for content.js, which can't import GATE_FIRST_RUN.
  const all = gatesFor({
    interest: { favourites: 1 }, counts: { lastHour: 99 }, settings: settings(), confirmedDelete: false
  });
  assert.deepEqual(all.filter(g => g.remember).map(g => g.kind), [GATE_FIRST_RUN]);
  for (const g of all) assert.equal(typeof g.remember, 'boolean', 'remember is never undefined');
});

// ====================================================================================
// describeOutcome / describeFailure
// ====================================================================================

test('a completed relist reads as ok', () => {
  const m = describeOutcome({ oldId: '111', newId: 999, newUrl: 'https://www.vinted.de/items/999' });
  assert.equal(m.kind, 'ok');
  assert.equal(m.text, 'Fertig.');
  assert.equal(m.newId, 999);
  assert.equal(m.newUrl, 'https://www.vinted.de/items/999');
});

test('a test-mode run warns and carries both links', () => {
  const m = describeOutcome({
    testMode: true, oldId: '111', newId: 999,
    newUrl: 'https://www.vinted.de/items/999', oldUrl: 'https://www.vinted.de/items/111'
  });
  assert.equal(m.kind, 'warning');
  assert.match(m.text, /NICHT gelöscht/);
  assert.equal(m.oldUrl, 'https://www.vinted.de/items/111');
  assert.equal(m.newUrl, 'https://www.vinted.de/items/999');
});

test('a partial run surfaces the pipeline warning verbatim and lingers', () => {
  const m = describeOutcome({ partial: true, newId: 999, newUrl: 'u', warning: 'Ownership mismatch — original NOT deleted' });
  assert.equal(m.kind, 'warning');
  assert.equal(m.text, 'Ownership mismatch — original NOT deleted');
  assert.equal(m.autoHideMs, 10000, 'a partial result must stay on screen longer');
});

test('a failure reads as an error', () => {
  const m = describeFailure(new Error('Anti-Bot-Schutz hat den Request blockiert.'));
  assert.equal(m.kind, 'error');
  assert.match(m.text, /^Fehler: Anti-Bot-Schutz/);
  assert.equal(m.autoHideMs, 10000);
});

test('describeFailure copes with a non-Error and with nothing at all', () => {
  assert.equal(describeFailure('kaputt').text, 'Fehler: kaputt');
  assert.equal(describeFailure().text, 'Fehler: unbekannt');
});

test('every message kind is one both UIs can render', () => {
  const messages = [
    describeOutcome({ newId: 1 }),
    describeOutcome({ testMode: true }),
    describeOutcome({ partial: true, warning: 'x' }),
    describeFailure(new Error('x'))
  ];
  for (const m of messages) {
    assert.ok(['ok', 'warning', 'error'].includes(m.kind), `unexpected kind: ${m.kind}`);
    assert.equal(typeof m.text, 'string');
  }
});

// ---------- the auto-listing's gates ----------

test('draftGatesFor: the dry run needs no warning — nothing becomes public', () => {
  const gates = draftGatesFor({ settings: { draftCreateEnabled: false }, confirmedCreate: false });
  assert.deepEqual(gates, []);
});

test('draftGatesFor: the first LIVE create is announced, once', () => {
  const gates = draftGatesFor({ settings: { draftCreateEnabled: true }, confirmedCreate: false });
  assert.equal(gates.length, 1);
  assert.equal(gates[0].kind, GATE_FIRST_CREATE);
  assert.equal(gates[0].remember, true);
  assert.match(gates[0].text, /öffentlich/);
});

test('draftGatesFor: once acknowledged it does not come back', () => {
  const gates = draftGatesFor({ settings: { draftCreateEnabled: true }, confirmedCreate: true });
  assert.deepEqual(gates, []);
});

test('draftGatesFor: it is a separate acknowledgement from the relist one', () => {
  // Accepting that a relist deletes the original says nothing about publishing a
  // machine-written listing.
  const gates = draftGatesFor({ settings: { draftCreateEnabled: true, deleteEnabled: true }, confirmedCreate: false });
  assert.equal(gates.length, 1);
  assert.notEqual(gates[0].kind, GATE_FIRST_RUN);
});

test('draftGatesFor: every gate has the shape both UIs render', () => {
  for (const gate of draftGatesFor({ settings: { draftCreateEnabled: true } })) {
    assert.equal(typeof gate.title, 'string');
    assert.ok(Array.isArray(gate.lines));
    assert.equal(typeof gate.note, 'string');
    assert.equal(typeof gate.remember, 'boolean');
  }
});

test('describeDraftOutcome: a dry run is neither success nor failure', () => {
  const m = describeDraftOutcome({ dryRun: true, payload: {} });
  assert.equal(m.kind, 'warning');
  assert.match(m.text, /Testlauf/);
  assert.equal(m.newId, undefined);
});

test('describeDraftOutcome: a real listing carries its link', () => {
  const m = describeDraftOutcome({ newId: 7, newUrl: 'https://www.vinted.de/items/7', title: 'Nike Hoodie M' });
  assert.equal(m.kind, 'ok');
  assert.equal(m.newId, 7);
  assert.match(m.text, /Nike Hoodie M/);
});

// ---------- das Schild oben rechts ----------
//
// Es stand als fester Text im HTML und behauptete „Stufe 1 — kein Kontakt zu Vinted",
// während die Seite Kategorien auflöste, Preise holte und Fotos hochlud. Die Stufen sind
// seit 0.91.0 ganz weg: sie sind eine Entwicklungslandkarte und beantworten nicht, was
// der nächste Klick bewirkt.

test('publishModeNote: der Testlauf sagt, dass kein INSERAT entsteht — nicht, dass nichts passiert', () => {
  // Der Testlauf lädt jedes Foto zu Vinted hoch und fragt dort die Erkennung; nur der
  // Create unterbleibt. „bei Vinted entsteht nichts" wäre für jemanden, der wegen der
  // Fotos zögert, eine falsche Zusicherung.
  const note = publishModeNote({ settings: { draftCreateEnabled: false } });
  assert.equal(note.kind, 'dry');
  assert.match(note.text, /Testlauf/);
  assert.match(note.button, /Testlauf/);
  assert.match(note.hint, /Fotos gehen hoch/);
  assert.match(note.hint, /Inserat entsteht nicht/);
});

test('publishModeNote: scharf sagt, dass es öffentlich wird', () => {
  const note = publishModeNote({ settings: { draftCreateEnabled: true } });
  assert.equal(note.kind, 'live');
  assert.match(note.text, /Scharf/);
  assert.equal(note.button, 'Veröffentlichen');
  assert.match(note.hint, /öffentlich/);
});

test('publishModeNote: keine Stufen mehr, in keinem Feld', () => {
  for (const draftCreateEnabled of [false, true]) {
    const note = publishModeNote({ settings: { draftCreateEnabled } });
    for (const field of [note.text, note.button, note.hint]) {
      assert.doesNotMatch(field, /Stufe/, `„Stufe" steht noch in: ${field}`);
    }
  }
});

test('publishModeNote: ohne Argumente die harmloseste Aussage', () => {
  // Die Oberfläche rendert, bevor die Einstellungen geladen sind. Solange darf dort nicht
  // „scharf" stehen — und erst recht nicht umgekehrt.
  assert.equal(publishModeNote().kind, 'dry');
});

// ---------- das Studio leeren ----------

test('resetGateFor: ein leeres Studio fragt nicht', () => {
  assert.equal(resetGateFor({ hasWork: false, published: false }), null);
  assert.equal(resetGateFor(), null);
});

test('resetGateFor: nach dem Einstellen fragt es auch nicht — das Leeren IST der nächste Schritt', () => {
  assert.equal(resetGateFor({ hasWork: true, published: true }), null);
});

test('resetGateFor: dazwischen wird gefragt, und der Satz nennt den Verlust', () => {
  const gate = resetGateFor({ hasWork: true, published: false });
  assert.match(gate.title, /leeren/i);
  assert.match(gate.note, /nur in diesem Tab/);
  assert.equal(gate.remember, false, 'diese Frage merkt man sich nicht weg');
  assert.deepEqual(gate.lines, [], 'jedes Gate hat ein Array, damit kein Renderer prüfen muss');
});

// ---------- der fertige Draft ----------

test('publishedNote: ohne Inserat gibt es nichts zu melden', () => {
  assert.equal(publishedNote({ publishedId: null }), null);
  assert.equal(publishedNote(), null);
});

test('publishedNote: mit Inserat nennt sie die Nummer und den nächsten Schritt', () => {
  const note = publishedNote({ publishedId: 9748658270 });
  assert.equal(note.kind, 'ok', 'ein Erfolg wird nicht als Warnung gerendert');
  assert.match(note.text, /9748658270/, 'die Nummer ist das Einzige, womit man es wiederfindet');
  assert.match(note.text, /Nächster Artikel/);
});
