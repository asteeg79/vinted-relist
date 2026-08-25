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
 * Die belegten Sprachen, mit dem Namen, den ein Mensch liest.
 *
 * `de: 6437` — gemessen am 2026-08-23 an einem von Hand eingestellten Comic auf
 * vinted.de (Artikel 9749905948, Kategorie 5425). Vinted speicherte
 * `item_attributes: [{code: 'language_book', ids: [6437]}, {code: 'condition', ids: [2]}]`.
 *
 * Der `label` ist kein Beiwerk: die Sprache ist ein Feld, das im Studio zur Auswahl steht,
 * und „Deutsch" ist die Auswahl, „de" der Schlüssel. Wächst diese Liste, wächst das
 * Auswahlfeld mit — ohne eine zweite Tabelle irgendwo in der Oberfläche.
 */
export const BOOK_LANGUAGES = [
  { code: 'de', label: 'Deutsch', id: 6437 }
];

/**
 * Die Auswahl fürs Feld: `{ value, label }`, wie jedes andere Auswahlfeld sie führt.
 *
 * Eine Konstante, keine Funktion: die Liste ändert sich nur, wenn jemand `book.js` ändert.
 * Sie bei jedem Zeichnen eines Feldes neu zu bauen, wäre eine Zusicherung, die niemand
 * braucht — und `draft-view.js` ruft sie für jedes Feld jedes Drafts auf.
 */
export const BOOK_LANGUAGE_OPTIONS = BOOK_LANGUAGES.map(({ code, label }) => ({ value: code, label }));

/** „de-DE" und „DE " meinen dieselbe Sprache wie „de". */
const twoLetter = value => String(value ?? '').trim().toLowerCase().slice(0, 2);

/**
 * Vinteds ID zu einem Sprachkürzel, oder null. Null heißt: nicht belegt, nicht geraten.
 *
 * Gesucht wird in der Liste selbst. Es gab hier einmal eine daraus abgeleitete Zuordnung
 * `{ de: 6437 }` — und mit ihr eine Gefahr, die es ohne sie gar nicht gibt: in einem Objekt
 * ist `constructor` ein Treffer, in einer Liste nicht. Der `hasOwnProperty`-Umweg und der
 * Test dagegen waren beide nur nötig, weil die Tabelle zweimal existierte.
 */
export function bookLanguageId(code) {
  const key = twoLetter(code);
  return BOOK_LANGUAGES.find(l => l.code === key)?.id ?? null;
}

/**
 * Welche Sprache für dieses Buch gilt, und woher sie kommt.
 *
 * Drei Quellen, in dieser Reihenfolge:
 *   1. was der Nutzer im Feld gewählt hat — seine Wahl schlägt jede Erkennung
 *   2. was das Modell auf dem Umschlag gelesen hat — es hat das Buch gesehen
 *   3. sonst die Sprache der Texte aus den Einstellungen. Dieselbe Annahme trifft Vinteds
 *      eigenes Formular: es fragt nicht und schickt die des Marktplatzes mit.
 *
 * Die erste Quelle kam dazu, weil die Sperre sonst eine Sackgasse war: las das Modell eine
 * Sprache falsch, blieb der Draft unveröffentlichbar, ohne dass es irgendwo etwas zu ändern
 * gab. Eine Sperre ohne Feld ist keine Prüfung, sondern eine Wand.
 *
 * Gibt `{ code, id, source }` zurück; `id` ist null, wenn die Sprache nicht belegt ist.
 */
export function chooseBookLanguage({ analysis = null, settings = {}, override = null } = {}) {
  // Eine gelesene, aber unbelegte Sprache behält ihr Kürzel — die Meldung soll sagen
  // können, WELCHE fehlt. „unbekannt" hilft niemandem beim Nachtragen.
  const picked = twoLetter(override);
  const fromModel = twoLetter(analysis?.book_language);
  const code = picked || fromModel || twoLetter(settings.draftLanguage) || null;
  return {
    code,
    id: bookLanguageId(code),
    source: picked ? 'user' : (fromModel ? 'ai' : 'default')
  };
}

/** Der Attributbeutel für die Payload — leer, wenn es nichts Belegtes zu senden gibt. */
export function bookLanguageAttributes(id) {
  return id == null ? [] : [{ code: 'language_book', ids: [id] }];
}

/**
 * Eine ISBN in der Form, die Vinted annimmt — oder null.
 *
 * WARUM DAS NICHT DER ROHTEXT SEIN DARF. Auf jedem Buchrücken steht die ISBN MIT
 * Bindestrichen: `978-3-16-148410-0`. Das ist dieselbe Nummer, nur lesbar gesetzt — und
 * genau so tippt sie jemand ab, und genau so liest das Modell sie vom Umschlag. Ungeprüft
 * durchgereicht kam sie bei `createItem` an, und der Fehlschlag stand erst NACH dem
 * Foto-Upload da. Die Bindestriche gehören also weg, nicht der Draft angehalten.
 *
 * WAS GEPRÜFT WIRD, IST DIE FORM: 13 Ziffern (moderne ISBN-13) oder 10 Zeichen, deren
 * letztes ein X sein darf (alte ISBN-10, Prüfziffer 10). Die PRÜFZIFFER wird bewusst nicht
 * nachgerechnet — ob Vinted das tut, ist nicht gemessen, und ein selbstgebauter Prüfer, der
 * eine echte ISBN ablehnt, wäre schlimmer als der Fehler, den er finden soll.
 *
 * Ein Wert, der nicht normalisiert, ist kein Grund zum Raten: `draft-view.js` zeigt ihn
 * weiter an und blockt, so wie bei einer Kategorie ohne Vinted-ID.
 */
export function normaliseIsbn(value) {
  const raw = String(value ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  return /^\d{13}$|^\d{9}[\dX]$/.test(raw) ? raw : null;
}
