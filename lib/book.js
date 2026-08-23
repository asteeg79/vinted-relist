/**
 * Die Sprache eines Buchs — Vinteds `language_book`, einmal aufgeschrieben.
 *
 * WARUM ES DIESE DATEI GIBT. Ein Buchinserat wird ohne sie abgelehnt:
 * `400 language_book: Wähle eine Sprache, um fortzufahren`. Und Vinted sagt an keiner
 * Stelle, welche IDs es gibt — geprüft am 2026-08-23:
 *
 *   · `POST /api/v2/item_upload/attributes` antwortet für Buchkategorien `attributes: []`
 *     — dieselbe leere Antwort, die auch die SPA bekommt
 *   · das Upload-Formular zeigt für Comics gar kein Sprachfeld; die SPA schickt die
 *     Sprache unsichtbar mit
 *   · `item_attributes/…`, `attribute_values?code=…` und die übrigen naheliegenden
 *     Endpunkte gibt es nicht (404)
 *   · die öffentliche Artikelansicht (`/api/v2/items/{id}`) führt gar keine Attribute
 *
 * Bleibt eine Quelle: ein Buch von Hand einstellen und nachlesen, was Vinted gespeichert
 * hat. Genau so ist der eine Eintrag unten entstanden.
 *
 * WAS HIER NICHT STEHT, WIRD NICHT GERATEN (ADR-0005). Eine falsche Sprach-ID setzt eine
 * falsche Sprache in ein öffentliches Inserat, und niemandem fällt das auf, bis ein Käufer
 * ein englisches Buch auspackt. Für eine Sprache ohne Eintrag hält `draft.js` den Draft an,
 * bevor das erste Foto hochgeht — und der Weg zu einem neuen Eintrag ist derselbe wie zu
 * diesem: ein Buch von Hand einstellen, `GET /api/v2/item_upload/items/{id}` lesen, die ID
 * hier eintragen.
 */

/**
 * ISO-639-1 → Vinteds `language_book`-ID.
 *
 * `de: 6437` — gemessen am 2026-08-23 an einem von Hand eingestellten Comic auf
 * vinted.de (Artikel 9749905948, Kategorie 5425). Vinted speicherte
 * `item_attributes: [{code: 'language_book', ids: [6437]}, {code: 'condition', ids: [2]}]`.
 */
export const BOOK_LANGUAGE_IDS = {
  de: 6437
};

/** „de-DE" und „DE " meinen dieselbe Sprache wie „de". */
const twoLetter = value => String(value ?? '').trim().toLowerCase().slice(0, 2);

/** Vinteds ID zu einem Sprachkürzel, oder null. Null heißt: nicht belegt, nicht geraten. */
export function bookLanguageId(code) {
  const key = twoLetter(code);
  return Object.prototype.hasOwnProperty.call(BOOK_LANGUAGE_IDS, key) ? BOOK_LANGUAGE_IDS[key] : null;
}

/**
 * Welche Sprache für dieses Buch gilt, und woher sie kommt.
 *
 * Zwei Quellen, in dieser Reihenfolge:
 *   1. was das Modell auf dem Umschlag gelesen hat — es hat das Buch gesehen
 *   2. sonst die Sprache der Texte aus den Einstellungen. Dieselbe Annahme trifft Vinteds
 *      eigenes Formular: es fragt nicht und schickt die des Marktplatzes mit.
 *
 * Gibt `{ code, id, source }` zurück; `id` ist null, wenn die Sprache nicht belegt ist.
 */
export function chooseBookLanguage({ analysis = null, settings = {} } = {}) {
  // Eine gelesene, aber unbelegte Sprache behält ihr Kürzel — die Meldung soll sagen
  // können, WELCHE fehlt. „unbekannt" hilft niemandem beim Nachtragen.
  const fromModel = twoLetter(analysis?.book_language);
  const code = fromModel || twoLetter(settings.draftLanguage) || null;
  return { code, id: bookLanguageId(code), source: fromModel ? 'ai' : 'default' };
}

/** Der Attributbeutel für die Payload — leer, wenn es nichts Belegtes zu senden gibt. */
export function bookLanguageAttributes(id) {
  return id == null ? [] : [{ code: 'language_book', ids: [id] }];
}
