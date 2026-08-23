import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_OK, FIELD_NEEDS_CONFIRMATION, FIELD_MISSING, draftView
} from '../lib/draft-view.js';
import { memoryKey, rememberPrice } from '../lib/price-memory.js';
import { PROFILES, buildTitle } from '../lib/title.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';

/** Vinteds Zustandsliste für eine Kleidungskategorie, gemessen am 2026-08-20. */
const CONDITIONS = [
  { id: 6, title: 'Neu, mit Etikett' },
  { id: 1, title: 'Neu' },
  { id: 2, title: 'Sehr gut' },
  { id: 3, title: 'Gut' },
  { id: 4, title: 'Zufriedenstellend' }
];

/** A confidently recognised hoodie — every slot filled, everything above the threshold. */
function analysis(overrides = {}) {
  return {
    brand: 'Nike',
    brand_confidence: 0.95,
    type: 'Hoodie',
    type_confidence: 0.97,
    size_label: 'M',
    size_source: 'label_photo',
    category_group: 'clothing',
    colors: ['Schwarz'],
    material: 'Baumwolle',
    description_sentence: 'Ein schlichter Hoodie.',
    description_facts: [
      { label: 'Material', value: 'Baumwolle' },
      { label: 'Passform', value: 'gerade' }
    ],
    photo_order: [
      { index: 1, role: 'Gesamtansicht vorn', cropped_off: false },
      { index: 0, role: 'Etikett', cropped_off: false }
    ],
    notes: [],
    ...overrides
  };
}

/** The state of one field by key. */
const state = (view, key) => view.fields.find(f => f.key === key)?.state;
const field = (view, key) => view.fields.find(f => f.key === key);

/**
 * Everything a draft needs to be publishable: price set, condition confirmed — and a
 * resolved CATEGORY.
 *
 * The category's id used to be absent here, and the suite was green anyway. That was the
 * fixture encoding the bug: a draft whose category never resolved counted as ready,
 * `canPublish` went true, and the failure surfaced only in `buildNewItemPayload`
 * (`Pflichtfeld fehlt: catalog_id`) — after the write lock was taken and three photos had
 * been uploaded. The labels are kept identical to the model's words so the titles under
 * test do not move; only the ids a real resolution carries are added.
 */
function ready(overrides = {}) {
  return {
    analysis: analysis(),
    settings: DEFAULT_SETTINGS,
    // Katalog, Farbe UND Größe — die drei, deren Wert ohne Vinteds ID nichts wert ist
    // (`NEEDS_ID`). Die Größe kam am 2026-08-23 dazu, nachdem ein echtes Inserat nach dem
    // Foto-Upload an `size: Wähle ein Größe` gescheitert war. Die Marke bleibt absichtlich
    // unaufgelöst: sie ist in der Payload nullbar, Vinted nimmt sogar eine Freitext-Marke.
    resolved: {
      catalog: { id: 1806, label: 'Hoodie', confidence: 1, candidates: [] },
      color: { id: 1, label: 'Schwarz', confidence: 1, candidates: [] },
      size: { id: 105, label: 'M', confidence: 1, candidates: [] }
    },
    price: { value: 18, source: 'range' },
    condition: 2,
    // Vinteds own list, as `taxonomy.conditions` returns it. The ids are the measured ones.
    conditions: CONDITIONS,
    confirmations: { condition: true },
    photos: [{ touchesEdge: false }, { touchesEdge: false }],
    ...overrides
  };
}

/** `ready()` but with one resolution replaced, the rest intact. */
const readyWith = (resolution, extra = {}) =>
  ready({ resolved: { ...ready().resolved, ...resolution }, ...extra });

// ---------- field states ----------

test('draftView: a confident, complete draft has every field ok', () => {
  const view = draftView(ready());
  for (const f of view.fields) {
    assert.equal(f.state, FIELD_OK, `${f.key} is ${f.state}: ${JSON.stringify(f)}`);
  }
  assert.equal(view.canPublish, true);
  assert.deepEqual(view.blockers, []);
});

test('draftView: a field below the confidence threshold needs confirmation', () => {
  const view = draftView(ready({ analysis: analysis({ brand_confidence: 0.5 }) }));
  assert.equal(state(view, 'brand'), FIELD_NEEDS_CONFIRMATION);
  assert.equal(view.canPublish, false);
});

test('draftView: confirming that field releases it — and only it', () => {
  // The category is RESOLVED but weakly — Vinted's own keyword search answers at 0.5, so
  // it has an id and still has to be looked at.
  const base = readyWith(
    { catalog: { id: 1806, label: 'Hoodie', confidence: 0.4, candidates: [] } },
    { analysis: analysis({ brand_confidence: 0.5 }) }
  );
  const view = draftView({ ...base, confirmations: { ...base.confirmations, brand: true } });
  assert.equal(state(view, 'brand'), FIELD_OK);
  assert.equal(state(view, 'category'), FIELD_NEEDS_CONFIRMATION);
  assert.equal(view.canPublish, false);
});

test('draftView: the threshold is the configured one, not a constant', () => {
  const base = ready({ analysis: analysis({ brand_confidence: 0.85 }) });
  assert.equal(state(draftView(base), 'brand'), FIELD_OK);
  const strict = draftView({ ...base, settings: { ...DEFAULT_SETTINGS, draftConfidenceThreshold: 0.9 } });
  assert.equal(state(strict, 'brand'), FIELD_NEEDS_CONFIRMATION);
});

test('draftView: a missing required field is missing, not merely unconfirmed', () => {
  // Ohne gelesene Größe gibt es auch nichts aufzulösen — die Fixture ohne beides.
  const view = draftView(readyWith({ size: undefined }, { analysis: analysis({ size_label: null, size_source: 'none' }) }));
  assert.equal(state(view, 'size'), FIELD_MISSING);
  assert.equal(view.canPublish, false);
  assert.ok(view.blockers.some(b => /Größe/.test(b)), view.blockers.join(' | '));
});

test('draftView: a size read off the label is trusted, an estimated one is not', () => {
  const read = draftView(ready({ analysis: analysis({ size_source: 'label_photo' }) }));
  assert.equal(state(read, 'size'), FIELD_OK);
  const guessed = draftView(ready({ analysis: analysis({ size_source: 'estimated' }) }));
  assert.equal(state(guessed, 'size'), FIELD_NEEDS_CONFIRMATION);
});

test('draftView: an optional field left empty does not block', () => {
  // Material is optional even where it is shown; a missing one must not stop publishing.
  const view = draftView(ready({
    analysis: analysis({ category_group: 'accessories', material: null, size_label: null, size_source: 'none' })
  }));
  assert.equal(state(view, 'material'), FIELD_OK);
  assert.equal(view.canPublish, true);
});

test('draftView: two equally good candidates are an ambiguity, not a pick', () => {
  const view = draftView(readyWith({
    catalog: { label: 'Hoodie', confidence: 0.99, candidates: [{ id: 1, label: 'Hoodies' }, { id: 2, label: 'Sweatshirts' }] }
  }));
  const f = field(view, 'category');
  // MISSING, not "confirm me": there is no catalog_id yet, and pressing "Passt" cannot
  // produce one. Only choosing from the candidates can.
  assert.equal(f.state, FIELD_MISSING);
  assert.equal(f.candidates.length, 2);
  assert.equal(view.canPublish, false);
});

test('draftView: an ambiguous brand IS confirmable — the brand is the one that may stay id-less', () => {
  // The payload takes `brand_id: null` plus a free-text brand; `catalog_id: null` is a throw.
  const view = draftView(readyWith(
    { brand: { label: 'Nike', confidence: 0.99, candidates: [{ id: 1, label: 'Nike' }, { id: 2, label: 'Nike ACG' }] } },
    { confirmations: { condition: true, brand: true } }
  ));
  assert.equal(state(view, 'brand'), FIELD_OK);
  assert.equal(view.canPublish, true);
});

test('draftView: der Zustand kommt nie aus einem getippten Wort', () => {
  // Toter Pfad, und einer mit Sprengkraft: über `overrides.condition` hätte ein Wort als
  // `status_id` einreisen können. Der Zustand kommt aus einem Auswahlfeld mit Vinteds
  // eigenen ids — sonst steht am Ende eine Stufe im Inserat, die Vinted nicht kennt.
  const view = draftView(ready({ condition: 2, overrides: { condition: 'sehr gut' } }));
  const f = field(view, 'condition');
  assert.equal(f.id, 2);
  assert.equal(f.value, 'Sehr gut', 'Vinteds Wort zur id, nicht das getippte');
});

test('draftView: eine überstimmte Erkennung steht als Hinweis da, nicht als Blocker', () => {
  const view = draftView(readyWith({
    catalog: {
      id: 1672, label: 'Hoodies & Sweatshirts', confidence: 1, candidates: [], agreed: true,
      overriddenBy: [{ id: 1811, label: 'Herren > Kleidung > Pullover & Sweater > Sweater' }]
    }
  }));
  const f = field(view, 'category');
  assert.equal(f.state, FIELD_OK);
  assert.equal(view.canPublish, true);
  assert.match(f.hint, /Vinted sieht/);
  assert.match(f.hint, /deine Wahl steht/);
});

// ---------- der Titel darf den Angaben nicht widersprechen ----------

test('draftView: der Titel nennt die aufgelöste Größe, nicht das getippte Wort', () => {
  // Live passiert am 2026-08-23: Titel „Under Armour Kinder Jungs Hose 146 Schwarz", im
  // Inserat gespeichert „Größe M". Wer nach M filtert, liest 146. Der Titel ist die eine
  // Stelle, an der eine falsche Größe niemandem auffällt, bis das Paket ankommt.
  const view = draftView(readyWith(
    { size: { id: 105, label: 'M', confidence: 1, candidates: [] } },
    { overrides: { size: '146' } }
  ));
  assert.match(view.title, /\bM\b/);
  assert.doesNotMatch(view.title, /146/);
});

test('draftView: ohne aufgelöste Größe steht im Titel, was getippt wurde', () => {
  // Solange keine ID dahintersteht, ist das getippte Wort das Beste, was es gibt — und das
  // Feld blockt ohnehin, bis eine ID da ist.
  const view = draftView(readyWith({ size: { id: null, label: null, confidence: 0, candidates: [] } },
    { overrides: { size: '146' } }));
  assert.match(view.title, /146/);
});

test('draftView: bei der Kategorie bleibt es umgekehrt — der Alltagsname gewinnt', () => {
  // Vinteds Ablagebezeichnung ist der schlechtere Titel („Einfarbige T-Shirts"), und die
  // Kategorie steht als eigene Angabe im Inserat — widersprechen kann sie dem Titel nicht.
  const view = draftView(readyWith(
    { catalog: { id: 1806, label: 'Einfarbige T-Shirts', confidence: 1, candidates: [] } },
    { overrides: { category: 'T-Shirt' } }
  ));
  assert.match(view.title, /T-Shirt /);
  assert.doesNotMatch(view.title, /Einfarbige/);
});

// ---------- warum das Preisfeld leer ist ----------

test('draftView: ein fehlender Preis sagt, woran es liegt', () => {
  const cases = [
    ['no_brand', /Marke/],
    ['no_comparables', /vergleichbare/],
    ['no_category', /Kategorie/],
    ['no_condition', /Zustand/]
  ];
  for (const [reason, pattern] of cases) {
    const hint = field(draftView(ready({ price: null, priceReason: reason })), 'price').hint;
    assert.match(hint, pattern, reason);
  }
});

test('draftView: eine gefundene Spanne braucht keine Erklärung', () => {
  assert.equal(field(draftView(ready()), 'price').hint, null);
  assert.equal(field(draftView(ready({ priceReason: 'no_analysis' })), 'price').hint, null);
});

test('draftView: nur der Preis und der Zustand erklären sich — kein Feld erfindet einen Hinweis', () => {
  const view = draftView(ready({ priceReason: 'no_brand' }));
  for (const f of view.fields.filter(f => f.key !== 'price' && f.key !== 'condition')) {
    assert.equal(f.hint, null, `${f.key} hat einen Hinweis erfunden`);
  }
});

// ---------- ein eingestelltes Inserat ist ein verbrauchter Draft ----------

test('draftView: nach dem Einstellen blockt derselbe Draft — sonst gibt es das Stück zweimal', () => {
  // Der Knopf war nach dem Erfolg sofort wieder aktiv: dieselben Fotos, derselbe Draft,
  // ein zweites öffentliches Inserat — und ohne Gate, weil die Erst-Bestätigung gemerkt
  // ist. Wer die Erfolgsmeldung übersieht, verkauft ein Stück zweimal.
  const view = draftView(ready({ publishedId: 9733959264 }));
  assert.equal(view.canPublish, false);
  assert.equal(view.done, true);
  assert.equal(view.publishedId, 9733959264);
});

test('draftView: ein fertiges Inserat ist KEIN Blocker — es fehlt ja nichts', () => {
  // Es stand als Blocker da und landete damit unter „Noch offen": „Bereits eingestellt
  // (Inserat …)". Das liest sich wie ein Mangel und ist der Erfolg. `blockers` beantwortet
  // „was fehlt noch" — ein fertiges Inserat gehört in keine Antwort darauf.
  const view = draftView(ready({ publishedId: 9733959264 }));
  assert.deepEqual(view.blockers, []);
});

test('draftView: ohne eingestelltes Inserat blockt nichts', () => {
  for (const publishedId of [null, undefined]) {
    const view = draftView(ready({ publishedId }));
    assert.equal(view.canPublish, true);
    assert.equal(view.done, false);
  }
});

// ---------- the colour needs an id too, and a conflict is not confirmable ----------

test('draftView: a colour Vinted disagreed about cannot be confirmed away', () => {
  // Der Trockenlauf vom 2026-08-21: die Gegenprobe widerspricht bei der Farbe, `crossCheck`
  // leert das Feld und bietet beide Antworten an — das Feld zeigt aber weiter „Blau". Ein
  // Klick auf „Passt" gab damit ein Inserat mit `color_ids: []` frei. Genau der Zwang zur
  // Neuauswahl, wegen dem die Farbe ein Blocker ist, ließ sich wegklicken.
  const view = draftView(readyWith(
    {
      color: {
        id: null, label: 'Blau', confidence: 0, agreed: false, source: 'conflict',
        candidates: [{ id: 9, label: 'Blau' }, { id: 17, label: 'Türkis' }]
      }
    },
    { confirmations: { condition: true, color: true } }
  ));
  const f = field(view, 'color');
  assert.equal(f.state, FIELD_MISSING, 'bestätigen kann keine ID herbeischaffen');
  assert.equal(f.id, null);
  assert.equal(view.canPublish, false);
});

test('draftView: the conflict note names both answers, and does not call Blau a non-colour', () => {
  const view = draftView(readyWith({
    color: {
      id: null, label: 'Blau', confidence: 0, agreed: false, source: 'conflict',
      candidates: [{ id: 9, label: 'Blau' }, { id: 17, label: 'Türkis' }]
    }
  }));
  const note = field(view, 'color').note;
  assert.match(note, /Blau oder Türkis/);
  assert.doesNotMatch(note, /keine Vinted-Farbe/, 'Blau IST eine Vinted-Farbe — Vinted sieht nur etwas anderes');
});

test('draftView: ohne Auswahl bekommt jedes Feld SEINEN Rat, nicht den der Kategorie', () => {
  // Gemeldet am 2026-08-23: „„152" ist keine Vinted-Größe — anderen Begriff eintippen,
  // z. B. „T-Shirts"". Ein Beispiel aus dem falschen Feld, und ein Rat, der damals ins
  // Leere führte, weil ein getipptes Größenwort nirgends aufgelöst wurde.
  const size = draftView(readyWith({ size: { id: null, label: '152', confidence: 0.9, candidates: [] } }));
  const note = field(size, 'size').note;
  assert.match(note, /keine Vinted-Größe/);
  assert.doesNotMatch(note, /T-Shirts/, 'das Beispiel der Kategorie gehört nicht unter die Größe');

  const category = draftView(readyWith({ catalog: { id: null, label: 'Hoodie', confidence: 0.9, candidates: [] } }));
  assert.match(field(category, 'category').note, /T-Shirts/);
});

test('draftView: a colour Vinted does not know says so in its own words', () => {
  const view = draftView(readyWith({
    color: { id: null, label: 'Petrol', confidence: 0, candidates: [{ id: 9, label: 'Blau' }] }
  }));
  assert.match(field(view, 'color').note, /keine Vinted-Farbe/);
});

test('draftView: die Marke darf ohne ID bleiben — sie ist in der Payload nullbar', () => {
  const view = draftView(readyWith(
    { brand: { id: null, label: 'Nike', confidence: 0.99, candidates: [] } },
    { confirmations: { condition: true, brand: true } }
  ));
  assert.equal(state(view, 'brand'), FIELD_OK);
  assert.equal(view.canPublish, true);
});

test('draftView: eine Größe ohne Vinted-ID lässt sich nicht bestätigen', () => {
  // Der echte Fehlschlag vom 2026-08-23: das Modell las „MD/M/M" vom Etikett, das ist keine
  // Vinted-Größe, das Feld zeigte `Größe=M[ok]` und im Kopf stand `größe=—`. Vinted lehnte
  // den Create nach dem Foto-Upload ab: `size: Wähle ein Größe, um fortzufahren`.
  const view = draftView(readyWith(
    { size: { id: null, label: 'MD/M/M', confidence: 0.99, candidates: [{ id: 105, label: 'M / 38 / 10' }] } },
    { confirmations: { condition: true, size: true } }
  ));
  const f = field(view, 'size');
  assert.equal(f.state, FIELD_MISSING);
  assert.match(f.note, /keine Vinted-Größe/);
  assert.equal(view.canPublish, false);
});

test('draftView: wo keine Größe verlangt wird, verlangt auch niemand eine ID', () => {
  // Medien führen gar kein Größenfeld, Accessoires eines ohne Pflicht. Die Sperre greift
  // nur, wo das Feld auch gebraucht wird.
  const view = draftView(ready({
    analysis: analysis({ category_group: 'media', size_label: null, size_source: 'none', isbn: '9783123456789' }),
    resolved: { catalog: { id: 2319, label: 'Belletristik', confidence: 1, candidates: [] } }
  }));
  assert.equal(view.fields.some(f => f.key === 'size'), false);
  assert.equal(view.canPublish, true);
});

test('draftView: das Feld sagt selbst, wo seine Auflösung liegt und ob Tippen nachschlägt', () => {
  // Das Studio hatte diese beiden Tabellen von Hand nachgebaut — samt einer dritten für die
  // Beschriftung, die bei Medien „Kategorie" statt „Titel" sagte.
  const view = draftView(ready());
  const by = key => view.fields.find(f => f.key === key);
  assert.equal(by('category').resolvedAs, 'catalog');
  assert.equal(by('category').relookupOnType, true);
  assert.equal(by('size').relookupOnType, true);
  assert.equal(by('color').relookupOnType, false, 'die Farbe bietet ihre ganze Liste an');
  assert.equal(by('price').resolvedAs, null);
});

test('draftView: Kandidaten sind Ziele oder Zwischenschritte, und das Feld sagt welches', () => {
  const treffer = draftView(readyWith({
    catalog: { id: null, label: 'X', confidence: 0, candidates: [{ id: 1, label: 'a' }, { id: 2, label: 'b' }] }
  }));
  assert.equal(field(treffer, 'category').candidateKind, 'hits');

  const schritte = draftView(readyWith({
    catalog: { id: null, label: 'X', confidence: 0, candidates: [{ path: 'Kinder > Jungs', label: 'Kinder > Jungs …' }] }
  }));
  assert.equal(field(schritte, 'category').candidateKind, 'steps');
});

// ---------- Bücher ohne ISBN nimmt Vinted nicht ----------

test('draftView: eine unbelegte Buchsprache blockt hier, nicht erst in der Pipeline', () => {
  // Sie stand einmal in `runPublish` — hinter dem Schreib-Schloss, nach dem Klick und den
  // Gates. Die Liste „Noch offen" konnte damit leer sein, während der Draft
  // unveröffentlichbar war. Die ISBN macht es über `LAYOUT.media.required` richtig.
  const view = draftView(ready({
    analysis: analysis({ category_group: 'media', size_label: null, size_source: 'none', isbn: '978', book_language: 'en' }),
    resolved: { catalog: { id: 2319, label: 'Belletristik', confidence: 1, candidates: [] } }
  }));
  assert.equal(view.canPublish, false);
  assert.ok(view.blockers.some(b => /Sprache „en"/.test(b)), view.blockers.join(' | '));
  assert.equal(view.bookLanguage.id, null);
});

test('draftView: eine belegte Sprache blockt nicht und reist zur Payload mit', () => {
  const view = draftView(ready({
    analysis: analysis({ category_group: 'media', size_label: null, size_source: 'none', isbn: '978', book_language: 'de' }),
    resolved: { catalog: { id: 2319, label: 'Belletristik', confidence: 1, candidates: [] } }
  }));
  assert.equal(view.canPublish, true);
  assert.deepEqual(view.bookLanguage, { code: 'de', id: 6437, source: 'ai' });
});

test('draftView: außerhalb der Medien gibt es keine Buchsprache', () => {
  assert.deepEqual(draftView(ready()).bookLanguage, { code: null, id: null, source: null });
});

test('draftView: ein Buch ohne ISBN blockt, bevor ein Foto hochgeht', () => {
  // Gemessen am 2026-08-23: `400 isbn: Bitte gib eine ISBN an, um weiterzugehen` — vom
  // Create, also nachdem alle Fotos oben waren.
  const view = draftView(ready({
    analysis: analysis({ category_group: 'media', size_label: null, size_source: 'none', isbn: null }),
    resolved: { catalog: { id: 2319, label: 'Belletristik', confidence: 1, candidates: [] } }
  }));
  assert.equal(state(view, 'isbn'), FIELD_MISSING);
  assert.equal(view.canPublish, false);
  assert.ok(view.blockers.some(b => /ISBN/.test(b)), view.blockers.join(' | '));
});

test('draftView: außerhalb der Medien gibt es gar kein ISBN-Feld', () => {
  // Ein T-Shirt hat keine, und ein Feld, das nie etwas enthalten kann, ist nur im Weg.
  assert.equal(draftView(ready()).fields.some(f => f.key === 'isbn'), false);
});

test('draftView: die ISBN kommt aus zwei Quellen, in dieser Reihenfolge', () => {
  // Vinteds eigene Lesung steht bewusst nicht dabei: sie kommt erst nach dem Upload, und
  // ein Buch ohne ISBN blockt lange davor — siehe `draft.js`.
  const media = over => draftView(ready({
    analysis: analysis({ category_group: 'media', size_label: null, size_source: 'none', isbn: '111' }),
    resolved: { catalog: { id: 2319, label: 'Belletristik', confidence: 1, candidates: [] } },
    ...over
  }));
  assert.equal(field(media({}), 'isbn').value, '111', 'was das Modell gelesen hat');
  assert.equal(field(media({ overrides: { isbn: '333' } }), 'isbn').value, '333', 'und der Nutzer schlägt es');
});

test('draftView: eine GESCHÄTZTE Größe bleibt bestätigungspflichtig, auch wenn sie passt', () => {
  // Vorher gewann die Konfidenz der Auflösung: eine an den Proportionen geschätzte Größe,
  // die zufällig auf einen Listeneintrag passte, stand als `ok` da und ging ungefragt
  // raus. Ein Treffer in der Liste macht eine Schätzung nicht sicherer (§7.2).
  const view = draftView(ready({ analysis: analysis({ size_source: 'estimated' }) }));
  assert.equal(field(view, 'size').id, 105, 'die ID ist da');
  assert.equal(state(view, 'size'), FIELD_NEEDS_CONFIRMATION, 'die Herkunft ist es nicht');
});

// ---------- the category needs an id, not a word ----------

test('draftView: an unresolved category blocks, however confidently the model named it', () => {
  // The 0.79.0 failure, as a test. The field LOOKS filled — it shows the model's "Hoodie" —
  // and its confidence is 0.97, so nothing else here would have stopped it.
  const view = draftView(readyWith({ catalog: undefined }));
  const f = field(view, 'category');
  assert.equal(f.value, 'Hoodie', 'the word is still shown — that is what makes it dangerous');
  assert.equal(f.id, null);
  assert.equal(f.state, FIELD_MISSING);
  assert.equal(view.canPublish, false);
});

test('draftView: confirming an unresolved category does not release it', () => {
  const view = draftView(readyWith({ catalog: undefined }, { confirmations: { condition: true, category: true } }));
  assert.equal(state(view, 'category'), FIELD_MISSING, '"Passt" cannot conjure a catalog_id');
  assert.equal(view.canPublish, false);
});

test('draftView: typing a category does not release it either', () => {
  // An override counts as a decision for every other field. Here it is just a word.
  const view = draftView(readyWith({ catalog: undefined }, { overrides: { category: 'Kapuzenpulli' } }));
  assert.equal(state(view, 'category'), FIELD_MISSING);
});

test('draftView: the blocker names the word Vinted did not recognise', () => {
  const view = draftView(readyWith({ catalog: undefined }));
  assert.match(field(view, 'category').note, /Hoodie/);
  assert.ok(view.blockers.some(b => /Hoodie/.test(b)), view.blockers.join(' | '));
});

test('draftView: with candidates the advice is to pick, without them to retype', () => {
  const withList = draftView(readyWith({
    catalog: { label: 'Hoodie', confidence: 0, candidates: [{ id: 1, label: 'Herren > Hoodies' }, { id: 2, label: 'Damen > Hoodies' }] }
  }));
  assert.match(field(withList, 'category').note, /aus der Liste/);
  assert.match(field(draftView(readyWith({ catalog: undefined })), 'category').note, /eintippen/);
});

test('draftView: a resolved category is ok once confirmed, id and all', () => {
  const view = draftView(readyWith(
    { catalog: { id: 1806, label: 'Hoodies & Sweaters', confidence: 0.5, candidates: [] } },
    { confirmations: { condition: true, category: true } }
  ));
  assert.equal(state(view, 'category'), FIELD_OK);
  assert.equal(field(view, 'category').id, 1806);
  assert.equal(view.canPublish, true);
});

test('draftView: a resolved id and label win over the raw string from the model', () => {
  const view = draftView(ready({
    resolved: { brand: { id: 53, label: 'Nike Sportswear', confidence: 0.99, candidates: [] } }
  }));
  const f = field(view, 'brand');
  assert.equal(f.value, 'Nike Sportswear');
  assert.equal(f.id, 53);
  assert.equal(f.state, FIELD_OK);
});

test('draftView: a value the user typed counts as confirmed', () => {
  const view = draftView(ready({
    analysis: analysis({ brand: null, brand_confidence: 0 }),
    overrides: { brand: 'Tommy Hilfiger' }
  }));
  const f = field(view, 'brand');
  assert.equal(f.value, 'Tommy Hilfiger');
  assert.equal(f.state, FIELD_OK);
});

// ---------- the pre-set condition ----------

test('draftView: the pre-set condition counts as unconfirmed until it is confirmed', () => {
  const view = draftView(ready({ confirmations: {} }));
  const f = field(view, 'condition');
  assert.equal(f.id, 2, 'the id is Vinted\'s status id, not our symbolic default');
  assert.equal(f.state, FIELD_NEEDS_CONFIRMATION);
  assert.equal(view.canPublish, false, 'a pre-selection must never publish itself');
  assert.ok(view.blockers.some(b => /Zustand/.test(b)));
});

test('draftView: even a condition the user picked has to be confirmed', () => {
  const view = draftView(ready({ condition: 6, confirmations: {} }));
  assert.equal(field(view, 'condition').id, 6);
  assert.equal(field(view, 'condition').state, FIELD_NEEDS_CONFIRMATION);
});

// ---------- the condition, as a word ----------
//
// It used to be the one field whose `value` was an id. The studio prints
// `Zustand=${f.value}` like every other field, so the log line read "Zustand=2" — a number
// nobody can check against the article in their hands.

test('draftView: the condition shows Vinteds word, and carries the id beside it', () => {
  const f = field(draftView(ready()), 'condition');
  assert.equal(f.value, 'Sehr gut');
  assert.equal(f.id, 2);
});

test('draftView: without Vinteds list the condition falls back to the bare id', () => {
  // The list arrives with the lookup; until then the field must not read as empty, or a
  // draft that HAS a condition would block on a missing one.
  const f = field(draftView(ready({ conditions: [] })), 'condition');
  assert.equal(f.value, '2');
  assert.equal(f.id, 2);
  assert.equal(f.state, FIELD_OK, 'confirmed stays confirmed while the list is missing');
});

test('draftView: an id Vinted does not know still shows, rather than vanishing', () => {
  const f = field(draftView(ready({ condition: 99 })), 'condition');
  assert.equal(f.value, '99');
  assert.equal(f.id, 99);
});

test('draftView: no condition means no id either', () => {
  const f = field(draftView(ready({ condition: null, confirmations: {} })), 'condition');
  assert.equal(f.value, null);
  assert.equal(f.id, null);
});

test('draftView: only the condition brings its own id — the others come from resolutions', () => {
  const view = draftView(ready({ resolved: {} }));
  for (const f of view.fields.filter(f => f.key !== 'condition')) {
    assert.equal(f.id, null, `${f.key} invented an id`);
  }
});

// ---------- price ----------

test('draftView: no price range means no price — never an estimate', () => {
  const view = draftView(ready({ price: null }));
  const f = field(view, 'price');
  assert.equal(f.value, null);
  assert.equal(f.state, FIELD_MISSING);
  assert.equal(view.canPublish, false);
});

test('draftView: a price is a normal ok field once it exists', () => {
  const view = draftView(ready({ price: { value: 24.5, source: 'manual' } }));
  assert.equal(field(view, 'price').value, 24.5);
  assert.equal(field(view, 'price').state, FIELD_OK);
});

test('draftView: a typed price is taken — as a number, not the string from the input', () => {
  const view = draftView(ready({ price: null, overrides: { price: '24,50' } }));
  assert.equal(field(view, 'price').value, 24.5);
  assert.equal(field(view, 'price').state, FIELD_OK);
  assert.equal(view.canPublish, true);
});

test('draftView: a typed price overrides the fetched range', () => {
  const view = draftView(ready({ price: { value: 18, source: 'range' }, overrides: { price: '31' } }));
  assert.equal(field(view, 'price').value, 31);
});

test('draftView: nonsense in the price field is no price', () => {
  for (const typed of ['', 'teuer', '-5', '0']) {
    const view = draftView(ready({ price: null, overrides: { price: typed } }));
    assert.equal(field(view, 'price').value, null, `"${typed}" was taken as a price`);
    assert.equal(field(view, 'price').state, FIELD_MISSING);
  }
});

test('draftView: a price under the configured floor has to be confirmed', () => {
  const settings = { ...DEFAULT_SETTINGS, draftMinPrice: 20 };
  const low = draftView(ready({ settings, price: { value: 8, source: 'range' } }));
  assert.equal(field(low, 'price').state, FIELD_NEEDS_CONFIRMATION);
  assert.match(field(low, 'price').note, /Untergrenze/);
  assert.ok(low.blockers.some(b => /Untergrenze/.test(b)), low.blockers.join(' | '));
  assert.equal(low.canPublish, false);

  const ok = draftView(ready({ settings, price: { value: 20, source: 'range' } }));
  assert.equal(field(ok, 'price').state, FIELD_OK);
  assert.equal(field(ok, 'price').note, null);
});

test('draftView: the floor is off at 0 — the default must not block anything', () => {
  const view = draftView(ready({ price: { value: 3, source: 'manual' } }));
  assert.equal(field(view, 'price').state, FIELD_OK);
});

test('draftView: confirming a price under the floor releases it', () => {
  const base = ready({ settings: { ...DEFAULT_SETTINGS, draftMinPrice: 20 }, price: { value: 8, source: 'range' } });
  const view = draftView({ ...base, confirmations: { ...base.confirmations, price: true } });
  assert.equal(field(view, 'price').state, FIELD_OK);
  assert.equal(view.canPublish, true);
});

// ---------- canPublish ----------

test('draftView: canPublish stays false while anything is unconfirmed, even with nothing missing', () => {
  const view = draftView(readyWith({ catalog: { id: 1806, label: 'Hoodie', confidence: 0.3, candidates: [] } }));
  assert.ok(view.fields.every(f => f.state !== FIELD_MISSING), 'nothing should be missing here');
  assert.equal(view.canPublish, false);
});

test('draftView: blockers name every open field, not just the first', () => {
  const view = draftView(ready({
    analysis: analysis({ size_label: null, size_source: 'none', brand_confidence: 0.2 }),
    confirmations: {},
    price: null
  }));
  assert.ok(view.blockers.length >= 4, view.blockers.join(' | '));
  assert.equal(view.canPublish, false);
});

test('draftView: without an analysis nothing crashes and nothing is publishable', () => {
  const view = draftView({ settings: DEFAULT_SETTINGS });
  assert.equal(view.canPublish, false);
  assert.ok(view.fields.length);
  assert.equal(view.title, '');
});

test('draftView: survives being called with no arguments at all', () => {
  const view = draftView();
  assert.equal(view.canPublish, false);
  assert.ok(Array.isArray(view.photos));
});

// ---------- title: the name, not the filing label ----------

test('draftView: the title uses the article\'s name, not Vinted\'s filing label', () => {
  // Measured on a real dry run: the category resolved to leaf 1806 "Einfarbige T-Shirts"
  // and the title became "Superdry Einfarbige T-Shirts M Blau". Resolving the category
  // made the title worse — plural, with a taxonomy qualifier nobody writes in a headline.
  const view = draftView(readyWith(
    {
      catalog: { id: 1806, label: 'Einfarbige T-Shirts', confidence: 1, candidates: [] },
      color: { id: 9, label: 'Blau', confidence: 1, candidates: [] }
    },
    { analysis: analysis({ brand: 'Superdry', type: 'T-Shirt', colors: ['Blau'] }) }
  ));
  assert.equal(view.title, 'Superdry T-Shirt M Blau');
  assert.equal(field(view, 'category').value, 'Einfarbige T-Shirts', 'the FIELD keeps Vinteds wording');
});

test('draftView: a word the user typed beats both', () => {
  const view = draftView(readyWith(
    { catalog: { id: 1806, label: 'Einfarbige T-Shirts', confidence: 1, candidates: [] } },
    { analysis: analysis({ type: 'T-Shirt' }), overrides: { category: 'Longsleeve' } }
  ));
  assert.ok(view.title.includes('Longsleeve'), view.title);
});

test('draftView: without a name from the model the leaf label stands in', () => {
  // Better a clumsy title than a title with a hole in it.
  const view = draftView(readyWith(
    { catalog: { id: 1806, label: 'Einfarbige T-Shirts', confidence: 1, candidates: [] } },
    { analysis: analysis({ type: null, type_confidence: 0 }), confirmations: { condition: true, category: true } }
  ));
  assert.ok(view.title.includes('Einfarbige T-Shirts'), view.title);
});

// ---------- title ----------

test('draftView: the title is buildTitle with the profile from the category group', () => {
  const view = draftView(ready());
  assert.equal(view.profile, 'clothing');
  assert.equal(view.title, buildTitle(
    { brand: 'Nike', type: 'Hoodie', size: 'M', color: 'Schwarz' }, PROFILES.clothing
  ));
  assert.equal(view.title, 'Nike Hoodie M Schwarz');
});

test('draftView: another category group selects another profile', () => {
  const view = draftView(readyWith(
    { catalog: { id: 3025, label: 'Umhängetasche', confidence: 1, candidates: [] } },
    { analysis: analysis({ category_group: 'accessories', type: 'Umhängetasche', size_label: null, size_source: 'none' }) }
  ));
  assert.equal(view.profile, 'accessories');
  assert.ok(!view.title.includes('M '), view.title);
  assert.ok(view.title.includes('Umhängetasche'));
});

test('draftView: an unknown category group falls back to generic', () => {
  const view = draftView(ready({ analysis: analysis({ category_group: 'moebel' }) }));
  assert.equal(view.profile, 'generic');
});

test('draftView: the title follows the confirmed value, not the model\'s original', () => {
  const view = draftView(ready({ overrides: { brand: 'Adidas' } }));
  assert.ok(view.title.startsWith('Adidas'), view.title);
});

// ---------- photos ----------

test('draftView: photos follow the suggested order, the first one is the cover', () => {
  const view = draftView(ready());
  assert.deepEqual(view.photos.map(p => p.index), [1, 0]);
  assert.equal(view.photos[0].isCover, true);
  assert.equal(view.photos[1].isCover, false);
  assert.equal(view.photos[0].role, 'Gesamtansicht vorn');
});

test('draftView: a cropped-off photo is marked but does not block', () => {
  const view = draftView(ready({
    analysis: analysis({
      photo_order: [
        { index: 0, role: 'Vorderseite', cropped_off: true },
        { index: 1, role: 'Etikett', cropped_off: false }
      ]
    })
  }));
  assert.ok(view.photos[0].warning, 'the finding must be visible');
  assert.equal(view.photos[1].warning, null);
  assert.equal(view.canPublish, true, 'a photo warning is not a blocker');
});

test('draftView: before the model has looked, the heuristic gets a note — not an alarm', () => {
  const view = draftView(ready({ photos: [{ touchesEdge: true }, { touchesEdge: false }] }));
  const noted = view.photos.find(p => p.index === 0);
  assert.equal(noted.warningLevel, 'note');
  assert.ok(noted.warning);
  assert.equal(view.canPublish, true);
});

test('draftView: once the model has judged a photo, its verdict outranks the heuristic', () => {
  // The peel stops at a shadow just as reliably as at a clipped sleeve, so a judged photo
  // with cropped_off: false must not keep carrying the heuristic's edge note.
  const view = draftView(ready({
    photos: [{ touchesEdge: true, judged: true }, { touchesEdge: true, judged: true }]
  }));
  assert.deepEqual(view.photos.map(p => p.warning), [null, null]);
});

test('draftView: a judged photo the model DID find cut off still warns', () => {
  const view = draftView(ready({
    analysis: analysis({
      photo_order: [
        { index: 0, role: 'Vorderseite', cropped_off: true },
        { index: 1, role: 'Etikett', cropped_off: false }
      ]
    }),
    photos: [{ touchesEdge: false, judged: true }, { touchesEdge: false, judged: true }]
  }));
  assert.equal(view.photos[0].warningLevel, 'warn');
  assert.equal(view.photos[1].warning, null);
});

test('draftView: each photo reports how it was processed and at what size', () => {
  const view = draftView(ready({
    photos: [
      { touchesEdge: false, judged: true, mode: 'pad', width: 1080, height: 1350 },
      { touchesEdge: false, judged: true, mode: 'crop', width: 1080, height: 1350 }
    ]
  }));
  const first = view.photos.find(p => p.index === 0);
  assert.equal(first.mode, 'pad');
  assert.equal(first.width, 1080);
  assert.equal(first.height, 1350);
});

test('draftView: photos the model forgot to order still show up, once each', () => {
  const view = draftView(ready({
    analysis: analysis({ photo_order: [{ index: 1, role: 'Vorderseite', cropped_off: false }] }),
    photos: [{ touchesEdge: false }, { touchesEdge: false }, { touchesEdge: false }]
  }));
  assert.equal(view.photos.length, 3);
  assert.deepEqual([...new Set(view.photos.map(p => p.index))].sort(), [0, 1, 2]);
});

test('draftView: an out-of-range index from the model is dropped, not rendered', () => {
  const view = draftView(ready({
    analysis: analysis({
      photo_order: [
        { index: 9, role: 'Geisterfoto', cropped_off: false },
        { index: 0, role: 'Vorderseite', cropped_off: false }
      ]
    })
  }));
  assert.ok(view.photos.every(p => p.index >= 0 && p.index < 2), JSON.stringify(view.photos));
});

// ---------- description ----------

test('draftView: the description is the sentence plus the facts as lines', () => {
  const view = draftView(ready());
  assert.equal(view.description, 'Ein schlichter Hoodie.\n\u2022 Material: Baumwolle\n\u2022 Passform: gerade');
});

test('draftView: an empty description blocks, without being a row of its own', () => {
  const empty = draftView(ready({
    analysis: analysis({ description_sentence: '', description_facts: [] })
  }));
  assert.equal(empty.descriptionState, FIELD_MISSING);
  assert.ok(empty.blockers.some(b => /Beschreibung/.test(b)), empty.blockers.join(' | '));
  assert.equal(empty.canPublish, false);
});

test('draftView: the description is not a field row — it has its own text area', () => {
  const view = draftView(ready());
  assert.equal(state(view, 'description'), undefined, 'the duplicate row is gone');
  assert.equal(view.descriptionState, FIELD_OK);
});

// ---------- price memory ----------

test('draftView: with no price set, what you charged last time is offered', () => {
  const key = memoryKey({ categoryGroup: 'clothing', brand: 'Nike', type: 'Hoodie' });
  const view = draftView(ready({ price: null, priceMemory: rememberPrice({}, key, 18) }));
  assert.equal(view.priceHint.price, 18);
  assert.equal(view.priceHint.match, 'exact');
  assert.equal(view.priceKey, key);
});

test('draftView: the hint is a hint — it never becomes the price by itself', () => {
  const key = memoryKey({ categoryGroup: 'clothing', brand: 'Nike', type: 'Hoodie' });
  const view = draftView(ready({ price: null, priceMemory: rememberPrice({}, key, 18) }));
  assert.equal(field(view, 'price').value, null);
  assert.equal(field(view, 'price').state, FIELD_MISSING);
  assert.equal(view.canPublish, false);
});

test('draftView: once a price is set the hint steps aside', () => {
  const key = memoryKey({ categoryGroup: 'clothing', brand: 'Nike', type: 'Hoodie' });
  const view = draftView(ready({ priceMemory: rememberPrice({}, key, 18) }));
  assert.equal(view.priceHint, null);
});

test('draftView: no history, no hint — nothing is invented', () => {
  const view = draftView(ready({ price: null }));
  assert.equal(view.priceHint, null);
  assert.equal(field(view, 'price').value, null);
});

test('draftView: the key follows a corrected brand, so the right history is found', () => {
  const nike = draftView(ready({ price: null }));
  const adidas = draftView(ready({ price: null, overrides: { brand: 'Adidas' } }));
  assert.notEqual(nike.priceKey, adidas.priceKey);
  assert.match(adidas.priceKey, /adidas/);
});

test('draftView: correcting a field pulls the matching fact along', () => {
  const view = draftView(ready({ overrides: { material: 'Wolle' } }));
  // The form knows "Material" only where the profile shows it — accessories here.
  const acc = draftView(ready({
    analysis: analysis({ category_group: 'accessories', size_label: null, size_source: 'none' }),
    overrides: { material: 'Wolle' }
  }));
  assert.ok(acc.description.includes('\u2022 Material: Wolle'), acc.description);
  assert.ok(!acc.description.includes('Baumwolle'), acc.description);
  // A fact the form does not track keeps the model's value.
  assert.ok(view.description.includes('\u2022 Passform: gerade'), view.description);
});

test('draftView: a fact naming an untracked label survives untouched', () => {
  const view = draftView(ready({
    analysis: analysis({ description_facts: [{ label: 'Besonderheit', value: 'Kapuze' }] })
  }));
  assert.ok(view.description.includes('\u2022 Besonderheit: Kapuze'), view.description);
});

test('draftView: a fact whose value went empty is dropped, not left dangling', () => {
  const view = draftView(ready({
    analysis: analysis({ description_facts: [{ label: 'Material', value: '' }] })
  }));
  assert.equal(view.description, 'Ein schlichter Hoodie.');
});

test('draftView: a description the user rewrote wins and is not recomposed under them', () => {
  const view = draftView(ready({
    overrides: { description: 'Von Hand geschrieben.', material: 'Wolle' }
  }));
  assert.equal(view.description, 'Von Hand geschrieben.');
  assert.equal(view.descriptionState, FIELD_OK);
});

// ---------- shape ----------

test('draftView: every field carries a label the studio can render without deciding', () => {
  for (const f of draftView(ready()).fields) {
    assert.equal(typeof f.key, 'string');
    assert.equal(typeof f.label, 'string');
    assert.ok(f.label.length, `${f.key} has no label`);
    assert.ok([FIELD_OK, FIELD_NEEDS_CONFIRMATION, FIELD_MISSING].includes(f.state));
    assert.ok(Array.isArray(f.candidates));
  }
});

test('draftView: without a condition the field is missing, not silently defaulted', () => {
  // The settings hold a preference, not a status_id. Turning one into the other is
  // condition.chooseCondition's job, and only once Vinted's list is known.
  const view = draftView(ready({ condition: null, confirmations: {} }));
  assert.equal(field(view, 'condition').value, null);
  assert.equal(state(view, 'condition'), FIELD_MISSING);
});

// ---------- where the condition came from ----------

test('draftView: a condition the recognition proposed says so, and says why', () => {
  const view = draftView(ready({
    condition: 3, confirmations: {},
    conditionMeta: { source: 'ai', evidence: 'Pilling an den Ärmeln' }
  }));
  assert.match(field(view, 'condition').hint, /Erkennung/);
  assert.match(field(view, 'condition').hint, /Pilling an den Ärmeln/);
});

test('draftView: a proposal without evidence still asks to be checked', () => {
  const view = draftView(ready({ condition: 3, confirmations: {}, conditionMeta: { source: 'ai' } }));
  assert.match(field(view, 'condition').hint, /prüfen/);
});

test('draftView: the default announces itself as one', () => {
  // The whole point: an unexplained "Sehr gut" invites a click, a named source invites a look.
  const view = draftView(ready({ condition: 2, confirmations: {}, conditionMeta: { source: 'default' } }));
  assert.match(field(view, 'condition').hint, /Voreinstellung/);
});

test('draftView: a condition the user picked needs no explanation', () => {
  const view = draftView(ready({ condition: 2, conditionMeta: { source: 'user' } }));
  assert.equal(field(view, 'condition').hint, null);
  assert.equal(draftView(ready({ condition: 2 })).fields.find(f => f.key === 'condition').hint, null);
});

test('draftView: a hint neither blocks nor turns up among the blockers', () => {
  const view = draftView(ready({
    condition: 3, confirmations: { condition: true },
    conditionMeta: { source: 'ai', evidence: 'Pilling an den Ärmeln' }
  }));
  assert.equal(state(view, 'condition'), FIELD_OK, 'a hint is not a note');
  assert.ok(!view.blockers.some(b => /Pilling/.test(b)), view.blockers.join(' | '));
});

test('draftView: only the condition carries a hint — no other field invents one', () => {
  const view = draftView(ready({ conditionMeta: { source: 'ai', evidence: 'x' } }));
  for (const f of view.fields.filter(f => f.key !== 'condition')) {
    assert.equal(f.hint, null, f.key);
  }
});

test('draftView: a proposed condition still has to be confirmed', () => {
  // §7.5 does not care where the value came from. The model having looked at photos is a
  // better cursor position, not a decision.
  const view = draftView(ready({ condition: 3, confirmations: {}, conditionMeta: { source: 'ai', evidence: 'Pilling' } }));
  assert.equal(state(view, 'condition'), FIELD_NEEDS_CONFIRMATION);
  assert.equal(view.canPublish, false);
});

// ---------- the description contradicting the fields ----------

test('draftView: a corrected colour that the sentence still asserts blocks', () => {
  // Verbatim from a dry run: Vinteds cross-check said Türkis, the user took it, and the
  // listing came out as "Superdry T-Shirt M Türkis" over "Blaues T-Shirt von Superdry…".
  // Splitting sentence from facts only protects the FACTS; a value inside the prose is
  // beyond re-derivation, so it has to be caught instead of quietly shipped.
  const view = draftView(readyWith(
    { color: { id: 17, label: 'Türkis', confidence: 1, candidates: [] } },
    {
      analysis: analysis({
        colors: ['Blau'],
        description_sentence: 'Blaues T-Shirt von Superdry Originals mit kleiner Brusttasche.'
      })
    }
  ));
  assert.equal(field(view, 'color').value, 'Türkis');
  assert.equal(view.descriptionState, FIELD_NEEDS_CONFIRMATION);
  assert.ok(view.blockers.some(b => /Blau/.test(b)), view.blockers.join(' | '));
  assert.equal(view.canPublish, false);
});

test('draftView: "Blau" is found inside "Blaues" — a word ending must not hide it', () => {
  const view = draftView(readyWith(
    { color: { id: 17, label: 'Türkis', confidence: 1, candidates: [] } },
    { analysis: analysis({ colors: ['Blau'], description_sentence: 'Ein blaues Shirt.' }) }
  ));
  assert.equal(view.descriptionState, FIELD_NEEDS_CONFIRMATION);
});

test('draftView: an uncorrected field is no contradiction, however often it is named', () => {
  const view = draftView(ready({
    analysis: analysis({ description_sentence: 'Ein schwarzer Hoodie von Nike, schlicht.' })
  }));
  assert.equal(view.descriptionState, FIELD_OK, 'Schwarz and Nike are still the values');
  assert.equal(view.canPublish, true);
});

test('draftView: Vinteds filing label is not a contradiction — that is its normal state', () => {
  // The category field holds "Einfarbige T-Shirts" while the article is called a T-Shirt.
  // Flagging that would fire on every single resolved draft.
  const view = draftView(readyWith(
    { catalog: { id: 1806, label: 'Einfarbige T-Shirts', confidence: 1, candidates: [] } },
    { analysis: analysis({ type: 'T-Shirt', description_sentence: 'Ein schlichtes T-Shirt.' }) }
  ));
  assert.equal(view.descriptionState, FIELD_OK);
});

test('draftView: a category the user actually retyped IS a contradiction', () => {
  const view = draftView(readyWith(
    { catalog: { id: 1806, label: 'Einfarbige T-Shirts', confidence: 1, candidates: [] } },
    {
      analysis: analysis({ type: 'Hoodie', description_sentence: 'Ein schlichter Hoodie.' }),
      overrides: { category: 'Longsleeve' }
    }
  ));
  assert.equal(view.descriptionState, FIELD_NEEDS_CONFIRMATION);
  assert.ok(view.blockers.some(b => /Hoodie/.test(b)), view.blockers.join(' | '));
});

test('draftView: a text the user wrote themselves is theirs, contradictions included', () => {
  const view = draftView(readyWith(
    { color: { id: 17, label: 'Türkis', confidence: 1, candidates: [] } },
    {
      analysis: analysis({ colors: ['Blau'], description_sentence: 'Blaues T-Shirt.' }),
      overrides: { description: 'Blaues T-Shirt, wie ich finde.' }
    }
  ));
  assert.equal(view.descriptionState, FIELD_OK, 'they took responsibility for the text');
  assert.equal(view.canPublish, true);
});

test('draftView: a value under three characters never triggers it', () => {
  // A size "M" or a colour "Ei" would match half the alphabet.
  const view = draftView(readyWith(
    { size: { id: 209, label: 'L', confidence: 1, candidates: [] } },
    { analysis: analysis({ size_label: 'M', description_sentence: 'Mit Muster am Saum.' }) }
  ));
  assert.equal(view.descriptionState, FIELD_OK);
});

test('draftView: an empty description is still MISSING, not a contradiction', () => {
  const view = draftView(ready({
    analysis: analysis({ description_sentence: '', description_facts: [] })
  }));
  assert.equal(view.descriptionState, FIELD_MISSING);
  assert.ok(view.blockers.some(b => /fehlt/.test(b)));
});
