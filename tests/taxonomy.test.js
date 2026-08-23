import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import {
  TAXONOMY_KEY, TTL,
  flattenCatalogs, findCatalog, sizesFromGroups, conditionsFromBody,
  parsePriceSuggestion, isFresh, lookupCachedCatalogs, createTaxonomy, browseCatalogs
} from '../lib/taxonomy.js';

/** The catalog tree as the spike measured it: nested, leaves carry an empty `catalogs`. */
const TREE = [
  {
    id: 5, title: 'Herren', catalogs: [
      {
        id: 10, title: 'Kleidung', catalogs: [
          { id: 1807, title: 'Bedruckte T-Shirts', catalogs: [] },
          { id: 1806, title: 'Einfarbige T-Shirts', catalogs: [] }
        ]
      }
    ]
  },
  { id: 1904, title: 'Damen', catalogs: [{ id: 196, title: 'Hoodies & Sweaters', catalogs: [] }] }
];

const PRICE_BODY = {
  price_suggestion: {
    minimum: { amount: '4.0', currency_code: 'EUR' },
    maximum: { amount: '9.0', currency_code: 'EUR' },
    midpoint: { amount: '6.0', currency_code: 'EUR' },
    price: { amount: '8.0', currency_code: 'EUR' },
    currency: 'EUR'
  },
  similar_sold_items_present: true,
  code: 0
};

/** A transport double: records calls, answers from a table. */
function fakeTransport(routes = {}) {
  const calls = [];
  const fetchJson = async (path, options = {}) => {
    calls.push({ path, ...options });
    const key = Object.keys(routes).find(k => path.startsWith(k));
    if (!key) throw new Error('unexpected path: ' + path);
    const answer = routes[key];
    return typeof answer === 'function' ? answer(path, options) : answer;
  };
  fetchJson.calls = calls;
  return fetchJson;
}

beforeEach(() => installChromeMock());

// ---------- pure helpers ----------

test('flattenCatalogs: every node once, with its readable path', () => {
  const flat = flattenCatalogs(TREE);
  assert.equal(flat.length, 6);
  const shirt = flat.find(c => c.id === 1807);
  assert.equal(shirt.title, 'Bedruckte T-Shirts');
  assert.equal(shirt.path, 'Herren > Kleidung > Bedruckte T-Shirts');
  assert.equal(shirt.isLeaf, true);
  assert.equal(flat.find(c => c.id === 5).isLeaf, false);
});

test('flattenCatalogs: survives an empty or malformed tree', () => {
  assert.deepEqual(flattenCatalogs(), []);
  assert.deepEqual(flattenCatalogs(null), []);
  assert.deepEqual(flattenCatalogs([{ id: 1 }]), [{ id: 1, title: '', path: '', isLeaf: true }]);
});

test('findCatalog: by id, null when unknown — never a near miss', () => {
  const flat = flattenCatalogs(TREE);
  assert.equal(findCatalog(flat, 196).title, 'Hoodies & Sweaters');
  assert.equal(findCatalog(flat, 999), null);
  assert.equal(findCatalog(flat, null), null);
});

test('sizesFromGroups: the size set as /item_upload/size_groups really answers it', () => {
  // Measured 2026-08-20 on www.vinted.de for catalog 221 (Damen > T-Shirts).
  const body = {
    size_groups: [{
      id: 4,
      caption: 'Größe',
      description: 'Kleidergrößen',
      size_ids: [102, 2],
      sizes: [
        { id: 102, title: 'XXS / 32 / 4', is_default: 0, is_other: 0, order: 2 },
        { id: 2, title: 'XS / 34 / 6', is_default: 0, is_other: 0, order: 4 }
      ]
    }],
    code: 0
  };
  assert.deepEqual(sizesFromGroups(body), [
    { id: 102, title: 'XXS / 32 / 4', group: 'Kleidergrößen' },
    { id: 2, title: 'XS / 34 / 6', group: 'Kleidergrößen' }
  ]);
});

test('sizesFromGroups: several groups are all valid answers, each size once', () => {
  const body = {
    size_groups: [
      { id: 38, description: 'Schuhe Männer', sizes: [{ id: 900, title: '42' }] },
      { id: 39, description: 'Schuhe UK', sizes: [{ id: 901, title: '8' }, { id: 900, title: '42' }] }
    ]
  };
  assert.deepEqual(sizesFromGroups(body).map(s => s.id), [900, 901], 'deduplicated by id');
  assert.equal(sizesFromGroups(body)[1].group, 'Schuhe UK');
});

test('sizesFromGroups: the empty answer stays empty — it must never become a guess', () => {
  // This is the exact body the WRONG parameter produced: `catalog_id` instead of
  // `catalog_ids[]` is answered 200 with an empty list, so nothing threw and no size ever
  // resolved. The parser cannot catch that; the URL below is what does.
  assert.deepEqual(sizesFromGroups({ size_groups: [], code: 0 }), []);
  assert.deepEqual(sizesFromGroups({}), []);
  assert.deepEqual(sizesFromGroups(null), []);
});

test('conditionsFromBody: the condition list comes from Vinted, with its own ids', () => {
  // Measured 2026-08-20: "Sehr gut" is 2, not 3 — which is why no table lives in our code.
  const body = {
    conditions: [
      { id: 6, title: 'Neu, mit Etikett', explanation: 'Ein brandneuer, unbenutzter Artikel mit Etikett.' },
      { id: 2, title: 'Sehr gut', explanation: 'Ein nur selten benutzter Artikel.' }
    ],
    code: 0
  };
  assert.deepEqual(conditionsFromBody(body), [
    { id: 6, title: 'Neu, mit Etikett', explanation: 'Ein brandneuer, unbenutzter Artikel mit Etikett.' },
    { id: 2, title: 'Sehr gut', explanation: 'Ein nur selten benutzter Artikel.' }
  ]);
});

test('conditionsFromBody: /api/v2/statuses answers under its own key', () => {
  assert.deepEqual(conditionsFromBody({ statuses: [{ id: 7, title: 'Nicht voll funktionsfähig' }] }),
    [{ id: 7, title: 'Nicht voll funktionsfähig', explanation: null }]);
  assert.deepEqual(conditionsFromBody({}), []);
  assert.deepEqual(conditionsFromBody(null), []);
});

test('conditions: from the per-category endpoint, cached per category', async () => {
  const fetchJson = fakeTransport({
    '/api/v2/item_upload/conditions': { conditions: [{ id: 2, title: 'Sehr gut', explanation: 'selten benutzt' }], code: 0 }
  });
  const taxonomy = createTaxonomy({ fetchJson });
  assert.deepEqual(await taxonomy.conditions(196), [{ id: 2, title: 'Sehr gut', explanation: 'selten benutzt' }]);
  await taxonomy.conditions(196);
  assert.equal(fetchJson.calls.length, 1);
  assert.match(fetchJson.calls[0].path, /catalog_id=196/);
  assert.equal(fetchJson.calls[0].method, undefined, 'a read, not a POST');
});

test('statuses: the general list, for a draft whose category has not resolved', async () => {
  const fetchJson = fakeTransport({
    '/api/v2/statuses': { statuses: [{ id: 2, title: 'Sehr gut' }, { id: 7, title: 'Nicht voll funktionsfähig' }] }
  });
  const taxonomy = createTaxonomy({ fetchJson });
  const list = await taxonomy.statuses();
  assert.deepEqual(list.map(c => c.id), [2, 7]);
  await taxonomy.statuses();
  assert.equal(fetchJson.calls.length, 1, 'cached like the per-category list');
});

// ---------- price suggestion ----------

test('parsePriceSuggestion: takes Vinted\'s own midpoint, not an average of our own', () => {
  const p = parsePriceSuggestion(PRICE_BODY);
  assert.equal(p.min, 4);
  assert.equal(p.max, 9);
  assert.equal(p.midpoint, 6, 'the arithmetic mean would be 6.5 — Vinted says 6');
  assert.equal(p.price, 8);
  assert.equal(p.currency, 'EUR');
  assert.equal(p.grounded, true);
});

test('parsePriceSuggestion: no comparable sales means no suggestion at all', () => {
  assert.equal(parsePriceSuggestion({ similar_sold_items_present: false, code: 0 }), null);
  assert.equal(parsePriceSuggestion({ ...PRICE_BODY, similar_sold_items_present: false }), null);
});

test('parsePriceSuggestion: a malformed body is no suggestion, never a guess', () => {
  assert.equal(parsePriceSuggestion(null), null);
  assert.equal(parsePriceSuggestion({}), null);
  assert.equal(parsePriceSuggestion({ price_suggestion: {}, similar_sold_items_present: true }), null);
  assert.equal(parsePriceSuggestion({
    price_suggestion: { minimum: { amount: 'teuer' }, maximum: { amount: '9.0' }, midpoint: { amount: '6.0' } },
    similar_sold_items_present: true
  }), null);
});

// ---------- cache ----------

test('isFresh: inside the TTL yes, outside no, missing never', () => {
  assert.equal(isFresh({ ts: 1000 }, 1000 + 500, 1000), true);
  assert.equal(isFresh({ ts: 1000 }, 1000 + 1500, 1000), false);
  assert.equal(isFresh(undefined, 5000, 1000), false);
  assert.equal(isFresh({}, 5000, 1000), false);
});

test('catalogs: fetched once, then served from the cache', async () => {
  const fetchJson = fakeTransport({ '/api/v2/item_upload/catalogs': { catalogs: TREE, code: 0 } });
  const taxonomy = createTaxonomy({ fetchJson });

  const first = await taxonomy.catalogs();
  const second = await taxonomy.catalogs();
  assert.equal(fetchJson.calls.length, 1, 'the tree is 486 KB — fetching it twice is the bug');
  assert.equal(first.length, 6);
  assert.deepEqual(first, second);
});

test('catalogs: a cache older than the TTL is refetched', async () => {
  const fetchJson = fakeTransport({ '/api/v2/item_upload/catalogs': { catalogs: TREE, code: 0 } });
  let clock = 0;
  const taxonomy = createTaxonomy({ fetchJson, now: () => clock });

  await taxonomy.catalogs();
  clock = TTL.catalogs + 1;
  await taxonomy.catalogs();
  assert.equal(fetchJson.calls.length, 2);
});

test('catalogs: the cache survives a new studio tab — it lives in storage', async () => {
  const routes = { '/api/v2/item_upload/catalogs': { catalogs: TREE, code: 0 } };
  const first = fakeTransport(routes);
  await createTaxonomy({ fetchJson: first }).catalogs();

  const second = fakeTransport(routes);
  const fresh = createTaxonomy({ fetchJson: second });
  assert.equal((await fresh.catalogs()).length, 6);
  assert.equal(second.calls.length, 0, 'a new instance must reuse the stored tree');
});

test('colors: cached like the tree', async () => {
  const colors = [{ id: 1, title: 'Schwarz', hex: '000000', code: 'BLACK' }];
  const fetchJson = fakeTransport({ '/api/v2/item_upload/colors': { colors, code: 0 } });
  const taxonomy = createTaxonomy({ fetchJson });
  await taxonomy.colors();
  await taxonomy.colors();
  assert.equal(fetchJson.calls.length, 1);
});

test('brands: never cached — the concept says live, and they are category-specific', async () => {
  const fetchJson = fakeTransport({
    '/api/v2/item_upload/brands': { brands: [{ id: 53, title: 'Nike' }], code: 0 }
  });
  const taxonomy = createTaxonomy({ fetchJson });
  await taxonomy.brands(196);
  await taxonomy.brands(196);
  assert.equal(fetchJson.calls.length, 2);
  assert.match(fetchJson.calls[0].path, /category_id=196/);
});

test('sizes: cached per category, not globally — the size set hangs off the category', async () => {
  const answer = path => ({
    size_groups: [{ id: 4, description: 'Kleidergrößen', sizes: [{ id: Number(path.split('=')[1]), title: 'M' }] }]
  });
  const fetchJson = fakeTransport({ '/api/v2/item_upload/size_groups': answer });
  const taxonomy = createTaxonomy({ fetchJson });

  const a = await taxonomy.sizes(196);
  const b = await taxonomy.sizes(196);
  const c = await taxonomy.sizes(1807);
  assert.equal(fetchJson.calls.length, 2, 'same category cached, different category fetched');
  assert.deepEqual(a, b);
  assert.equal(a[0].id, 196);
  assert.equal(c[0].id, 1807);
});

test('sizes: asks with catalog_ids[], the plural spelling Vinted actually answers', async () => {
  // The singular `catalog_id` returns 200 with an empty list. That is the whole bug: no
  // error, no size, and a draft that says "Größe fehlt" for every article.
  const fetchJson = fakeTransport({ '/api/v2/item_upload/size_groups': { size_groups: [] } });
  await createTaxonomy({ fetchJson }).sizes(1807);
  assert.match(fetchJson.calls[0].path, /\?catalog_ids\[\]=1807$/);
});

test('the taxonomy offers neither requiredFields nor packageSize — both were measured wrong', () => {
  // `offline_verification/criteria` answers `["brand","price"]` for every category there
  // is (eleven probed on 2026-08-21, from t-shirts to books) while the book upload form
  // has no brand field at all — it is not the category's mandatory set. And the parcel
  // suggestion lives on `api.vinted.<tld>`, refuses this transport's auth headers, and
  // needs an upload session that does not exist yet during preparation. Both now sit
  // where they belong: `draft.js`, through the content script.
  const taxonomy = createTaxonomy({ fetchJson: fakeTransport({}) });
  assert.equal(taxonomy.requiredFields, undefined);
  assert.equal(taxonomy.packageSize, undefined);
});

test('priceSuggestion: sends the three ids and never caches — the range moves', async () => {
  const fetchJson = fakeTransport({ '/api/v2/item_price_suggestions': PRICE_BODY });
  const taxonomy = createTaxonomy({ fetchJson });

  const p = await taxonomy.priceSuggestion({ catalogId: 196, brandId: 53, statusId: 2 });
  assert.equal(p.midpoint, 6);
  await taxonomy.priceSuggestion({ catalogId: 196, brandId: 53, statusId: 2 });
  assert.equal(fetchJson.calls.length, 2, 'a changed condition must produce a fresh range');

  const q = new URL('https://x' + fetchJson.calls[0].path).searchParams;
  assert.equal(q.get('catalog_id'), '196');
  assert.equal(q.get('brand_id'), '53');
  assert.equal(q.get('status_id'), '2');
});

test('priceSuggestion: without all three ids it does not even ask', async () => {
  const fetchJson = fakeTransport({ '/api/v2/item_price_suggestions': PRICE_BODY });
  const taxonomy = createTaxonomy({ fetchJson });
  assert.equal(await taxonomy.priceSuggestion({ catalogId: 196, statusId: 2 }), null);
  assert.equal(await taxonomy.priceSuggestion({ catalogId: 196, brandId: 53 }), null);
  assert.equal(await taxonomy.priceSuggestion({}), null);
  assert.equal(fetchJson.calls.length, 0, 'the spike showed an incomplete query is answered empty');
});

test('searchCatalogs: returns ids only — the names live in the tree', async () => {
  const fetchJson = fakeTransport({
    '/api/v2/item_upload/catalogs/search': { catalog_ids: [196, 1807], code: 0 }
  });
  const taxonomy = createTaxonomy({ fetchJson });
  assert.deepEqual(await taxonomy.searchCatalogs('Hoodie'), [196, 1807]);
  assert.match(fetchJson.calls[0].path, /keyword=Hoodie/);
});

test('searchCatalogs: escapes the keyword rather than pasting it into the URL', async () => {
  const fetchJson = fakeTransport({ '/api/v2/item_upload/catalogs/search': { catalog_ids: [] } });
  await createTaxonomy({ fetchJson }).searchCatalogs('T-Shirt & Top');
  assert.match(fetchJson.calls[0].path, /keyword=T-Shirt%20%26%20Top/);
});

// ---------- nebenläufige Schreibvorgänge dürfen sich nicht überschreiben ----------

test('cached: vier gleichzeitige Abrufe landen alle im Cache', async () => {
  // `lookupDraft` holt Marken, Farben, Größen und Zustände in einem `Promise.all`. Der
  // ganze Cache liegt unter EINEM Storage-Schlüssel: ohne Reihenfolge liest der zweite
  // Schreiber den Stand von vor dem ersten und überschreibt ihn beim `set`. Sichtbar wäre
  // das nur daran, dass eine Liste jedes Mal neu geholt wird.
  const fetchJson = fakeTransport({
    '/api/v2/item_upload/brands': { brands: [{ id: 53, title: 'Nike' }], code: 0 },
    '/api/v2/item_upload/colors': { colors: [{ id: 1, title: 'Schwarz' }], code: 0 },
    '/api/v2/item_upload/size_groups': { size_groups: [{ id: 9, sizes: [{ id: 105, title: 'M' }] }], code: 0 },
    '/api/v2/item_upload/conditions': { conditions: [{ id: 2, title: 'Sehr gut' }], code: 0 }
  });
  const taxonomy = createTaxonomy({ fetchJson });

  await Promise.all([taxonomy.brands(196), taxonomy.colors(), taxonomy.sizes(196), taxonomy.conditions(196)]);

  const { taxonomy: cache } = await chrome.storage.local.get('taxonomy');
  // Marken stehen absichtlich nicht dabei — die werden nie zwischengespeichert. Drei
  // gleichzeitige Schreiber auf einen Storage-Schlüssel reichen für das Rennen.
  assert.deepEqual(
    Object.keys(cache).sort(),
    ['colors', 'conditions:196', 'sizes:196'],
    'keiner der drei darf beim Schreiben verlorengehen'
  );

  // Und der zweite Durchgang holt nur noch, was nicht zwischengespeichert wird (Marken).
  const before = fetchJson.calls.length;
  await Promise.all([taxonomy.colors(), taxonomy.sizes(196), taxonomy.conditions(196)]);
  assert.equal(fetchJson.calls.length, before, 'alles kam aus dem Cache');
});

// ---------- transport is injected ----------

test('the transport is a parameter — no fetch, no chrome message, is hardcoded', async () => {
  const fetchJson = fakeTransport({ '/api/v2/item_upload/colors': { colors: [], code: 0 } });
  await createTaxonomy({ fetchJson }).colors();
  assert.equal(fetchJson.calls.length, 1);
  // Whether this ran as a direct fetch or over draft/lookup is the caller's business.
  assert.equal(typeof fetchJson.calls[0].path, 'string');
});

test('a failing transport propagates — a taxonomy hole must not become a silent default', async () => {
  const fetchJson = async () => { throw new Error('403'); };
  await assert.rejects(() => createTaxonomy({ fetchJson }).colors(), /403/);
});

test('a cached entry is not written for a failed fetch', async () => {
  const { store } = installChromeMock();
  const fetchJson = async () => { throw new Error('boom'); };
  await assert.rejects(() => createTaxonomy({ fetchJson }).catalogs());
  assert.equal(store[TAXONOMY_KEY], undefined);
});

// ---------- labelling suggested ids from the cache ----------

test('lookupCachedCatalogs: labels the ids Vinted suggested from the cached tree', async () => {
  const fetchJson = fakeTransport({ '/api/v2/item_upload/catalogs': { catalogs: TREE, code: 0 } });
  await createTaxonomy({ fetchJson }).catalogs(); // fills the cache

  const labelled = await lookupCachedCatalogs([1807, 196]);
  assert.deepEqual(labelled.map(c => c.id), [1807, 196]);
  assert.equal(labelled[0].path, 'Herren > Kleidung > Bedruckte T-Shirts');
});

test('lookupCachedCatalogs: an id the tree does not know is dropped, not faked', async () => {
  const fetchJson = fakeTransport({ '/api/v2/item_upload/catalogs': { catalogs: TREE, code: 0 } });
  await createTaxonomy({ fetchJson }).catalogs();
  assert.deepEqual(await lookupCachedCatalogs([999999]), []);
});

test('lookupCachedCatalogs: no cache and no ids are both simply empty', async () => {
  assert.deepEqual(await lookupCachedCatalogs([196]), []);
  assert.deepEqual(await lookupCachedCatalogs([]), []);
  assert.deepEqual(await lookupCachedCatalogs(null), []);
});

// ---------- durch den Baum navigieren ----------
//
// Gemeldet am 2026-08-23: für einen Kinderpullover schlug Vinteds Stichwortsuche nur
// „Herren > Sweatshirt" vor — ein einzelnes Blatt, also wurde es übernommen, und daran
// hing die ganze (falsche) Größenmenge. „Kinder" ist keine Kategorie, sondern ein Weg.

/** Ein Ausschnitt in der Form, die `flattenCatalogs` liefert — flach, mit Pfaden. */
const LEAVES = [
  { id: 1, title: 'Pullover', path: 'Kinder > Mädchen > Pullover und Jäckchen > Pullover', isLeaf: true },
  { id: 2, title: 'Rollkragenpullover', path: 'Kinder > Mädchen > Pullover und Jäckchen > Rollkragenpullover', isLeaf: true },
  { id: 3, title: 'Bodies', path: 'Kinder > Mädchen > Babykleidung > Bodies', isLeaf: true },
  { id: 4, title: 'Pullover', path: 'Kinder > Jungs > Pullover & Jäckchen > Pullover', isLeaf: true },
  { id: 5, title: 'Sweatshirts', path: 'Herren > Kleidung > Sweatshirts', isLeaf: true },
  { id: 6, title: 'Kinder & junge Erwachsene', path: 'Bücher & andere Medien > Bücher > Kinder & junge Erwachsene', isLeaf: true }
];

test('browseCatalogs: wenige Treffer sind eine Auswahl, keine Wanderung', () => {
  const { matches, steps } = browseCatalogs('kinder pullover', LEAVES);
  assert.deepEqual(matches.map(m => m.id), [1, 2, 4]);
  assert.deepEqual(steps, []);
});

test('browseCatalogs: zu viele Treffer werden zur nächsten Ebene', () => {
  const { matches, steps } = browseCatalogs('Kinder', LEAVES, { maxMatches: 2 });
  assert.deepEqual(matches, []);
  // „Kinder" selbst wäre ein Schritt ins Nichts — er wird durch seine Unterebenen ersetzt.
  assert.ok(steps.includes('Kinder > Mädchen'), steps.join(' | '));
  assert.ok(steps.includes('Kinder > Jungs'), steps.join(' | '));
  assert.ok(!steps.includes('Kinder'), 'ein Schritt, der das Getippte wiederholt, ist keiner');
  // Das Wort kommt auch anderswo vor, und das zu verschweigen wäre eine Auskunft, die
  // niemand geprüft hat.
  assert.ok(steps.some(s => /Bücher/.test(s)), steps.join(' | '));
});

test('browseCatalogs: ein Pfad wird verankert, nicht als Wortsuche gelesen', () => {
  // Ohne Verankerung fände „Kinder > Mädchen" auch Mädchen-Blätter außerhalb von Kinder.
  const { matches } = browseCatalogs('Kinder > Mädchen', LEAVES);
  assert.deepEqual(matches.map(m => m.id), [1, 2, 3]);
});

test('browseCatalogs: eine Ebene tiefer schneidet weiter zu', () => {
  const { matches } = browseCatalogs('Kinder > Mädchen > Pullover und Jäckchen', LEAVES);
  assert.deepEqual(matches.map(m => m.id), [1, 2]);
});

test('browseCatalogs: was nicht vorkommt, wird nicht erfunden', () => {
  assert.deepEqual(browseCatalogs('Gibtsnicht', LEAVES), { matches: [], steps: [] });
  assert.deepEqual(browseCatalogs('', LEAVES), { matches: [], steps: [] });
  assert.deepEqual(browseCatalogs('Kinder', []), { matches: [], steps: [] });
});
