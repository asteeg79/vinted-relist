import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOK_LANGUAGES, BOOK_LANGUAGE_OPTIONS, bookLanguageId,
  chooseBookLanguage, bookLanguageAttributes, normaliseIsbn
} from '../lib/book.js';

// Ein Buchinserat wird ohne `language_book` abgelehnt, und Vinted nennt die IDs nirgends
// (geprüft am 2026-08-23: Attribut-Endpunkt leer, kein Sprachfeld im Formular, alle
// naheliegenden Listen-Endpunkte 404, öffentliche Artikel ohne Attribute). Der eine
// Eintrag stammt aus einem von Hand eingestellten Comic.

test('bookLanguageId: Deutsch ist gemessen, alles andere ist es nicht', () => {
  assert.equal(bookLanguageId('de'), 6437);
  assert.equal(bookLanguageId('DE'), 6437);
  assert.equal(bookLanguageId('de-DE'), 6437, 'ein Gebietskürzel meint dieselbe Sprache');
  for (const unbelegt of ['en', 'fr', 'xx', '', null, undefined]) {
    assert.equal(bookLanguageId(unbelegt), null, String(unbelegt));
  }
});

test('bookLanguageId: nichts wird über den Umweg eines Prototyps erfunden', () => {
  // Die Gefahr gab es nur, solange die Tabelle als Objekt daneben lag: dort ist
  // `constructor` ein Treffer. Gesucht wird jetzt in der Liste selbst, wo er keiner ist —
  // der Test bleibt trotzdem stehen, damit ein Rückbau zur Zuordnung auffällt.
  assert.equal(bookLanguageId('constructor'), null);
  assert.equal(bookLanguageId('toString'), null);
});

test('chooseBookLanguage: was das Modell gelesen hat, gilt', () => {
  const r = chooseBookLanguage({ analysis: { book_language: 'de' }, settings: { draftLanguage: 'en' } });
  assert.deepEqual(r, { code: 'de', id: 6437, source: 'ai' });
});

test('chooseBookLanguage: sonst die Sprache der Texte — dieselbe Annahme wie Vinteds Formular', () => {
  // Das fragt nicht nach der Sprache und schickt die des Marktplatzes mit.
  const r = chooseBookLanguage({ analysis: { book_language: null }, settings: { draftLanguage: 'de' } });
  assert.deepEqual(r, { code: 'de', id: 6437, source: 'default' });
});

test('chooseBookLanguage: eine unbelegte Sprache kommt MIT Kürzel zurück, aber ohne ID', () => {
  // Die Meldung soll sagen, WELCHE fehlt — „unbekannt" hilft niemandem weiter.
  const r = chooseBookLanguage({ analysis: { book_language: 'en' }, settings: { draftLanguage: 'de' } });
  assert.equal(r.code, 'en');
  assert.equal(r.id, null, 'geraten wird nicht');
});

test('chooseBookLanguage: ohne alles bleibt alles leer', () => {
  assert.equal(chooseBookLanguage().id, null);
  assert.equal(chooseBookLanguage({}).code, null);
});

test('chooseBookLanguage: die Wahl des Nutzers schlägt beide Erkennungen', () => {
  // Ohne diesen Weg wäre die Sperre eine Sackgasse: liest das Modell die Sprache falsch,
  // bliebe der Draft unveröffentlichbar, ohne dass es irgendwo etwas zu ändern gäbe.
  const r = chooseBookLanguage({
    analysis: { book_language: 'en' },
    settings: { draftLanguage: 'en' },
    override: 'de'
  });
  assert.deepEqual(r, { code: 'de', id: 6437, source: 'user' });
});

test('chooseBookLanguage: eine leere Wahl ist keine Wahl', () => {
  // Sonst löschte ein zurückgesetztes Auswahlfeld die gelesene Sprache mit.
  const r = chooseBookLanguage({ analysis: { book_language: 'de' }, override: '' });
  assert.deepEqual(r, { code: 'de', id: 6437, source: 'ai' });
});

test('BOOK_LANGUAGE_OPTIONS: die Auswahl fürs Feld kommt aus derselben Liste wie die IDs', () => {
  // Zwei Tabellen — eine für die Auswahl, eine für die IDs — wären die Stelle, an der ein
  // nachgetragener Eintrag genau in einer der beiden stünde.
  assert.deepEqual(BOOK_LANGUAGE_OPTIONS, [{ value: 'de', label: 'Deutsch' }]);
  assert.deepEqual(BOOK_LANGUAGE_OPTIONS.map(o => o.value), BOOK_LANGUAGES.map(l => l.code));
  for (const { code, id } of BOOK_LANGUAGES) assert.equal(bookLanguageId(code), id);
});

test('bookLanguageAttributes: der Beutel trägt nur Belegtes', () => {
  assert.deepEqual(bookLanguageAttributes(6437), [{ code: 'language_book', ids: [6437] }]);
  assert.deepEqual(bookLanguageAttributes(null), []);
});

test('BOOK_LANGUAGES: jeder Eintrag ist gemessen — Kürzel, Name, Zahl', () => {
  for (const { code, label, id } of BOOK_LANGUAGES) {
    assert.match(code, /^[a-z]{2}$/, code);
    assert.ok(label && typeof label === 'string', `${code}: ohne Namen gibt es nichts auszuwählen`);
    assert.ok(Number.isInteger(id) && id > 0, `${code}: ${id}`);
  }
});

test('normaliseIsbn: so wie sie auf dem Buchrücken steht, gilt sie auch', () => {
  // Der eigentliche Fall: gedruckt wird IMMER mit Bindestrichen, und genau so tippt sie
  // jemand ab und liest das Modell sie. Ungeprüft durchgereicht scheiterte sie erst bei
  // `createItem` — nachdem alle Fotos oben waren.
  assert.equal(normaliseIsbn('978-3-16-148410-0'), '9783161484100');
  assert.equal(normaliseIsbn(' 978 3 16 148410 0 '), '9783161484100');
  assert.equal(normaliseIsbn('9783161484100'), '9783161484100');
});

test('normaliseIsbn: die alte ISBN-10 darf auf X enden', () => {
  // Prüfziffer 10 wird als X geschrieben. Ein Buch von 1998 hat keine andere.
  assert.equal(normaliseIsbn('3-16-148410-X'), '316148410X');
  assert.equal(normaliseIsbn('316148410x'), '316148410X', 'klein geschrieben meint dasselbe');
  assert.equal(normaliseIsbn('31614841X0'), null, 'das X gehört ans Ende, nicht irgendwohin');
});

test('normaliseIsbn: was keine Nummer ist, wird nicht zu einer gemacht', () => {
  for (const kein of ['978', '', '   ', null, undefined, 'Belletristik', '97831614841000', '978-3-16-148410-00']) {
    assert.equal(normaliseIsbn(kein), null, JSON.stringify(kein));
  }
});

test('normaliseIsbn: eine Zahl ist dieselbe Nummer wie ihre Ziffern', () => {
  // `ai.js` verwandelt eine gelieferte Zahl vorher in Ziffern; hier steht, dass die beiden
  // Wege zum selben Ergebnis führen.
  assert.equal(normaliseIsbn(9783161484100), '9783161484100');
});
