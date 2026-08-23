import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOK_LANGUAGE_IDS, bookLanguageId, chooseBookLanguage, bookLanguageAttributes } from '../lib/book.js';

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

test('bookLanguageAttributes: der Beutel trägt nur Belegtes', () => {
  assert.deepEqual(bookLanguageAttributes(6437), [{ code: 'language_book', ids: [6437] }]);
  assert.deepEqual(bookLanguageAttributes(null), []);
});

test('BOOK_LANGUAGE_IDS: jeder Eintrag ist eine Zahl, keine Vermutung', () => {
  for (const [code, id] of Object.entries(BOOK_LANGUAGE_IDS)) {
    assert.match(code, /^[a-z]{2}$/, code);
    assert.ok(Number.isInteger(id) && id > 0, `${code}: ${id}`);
  }
});
