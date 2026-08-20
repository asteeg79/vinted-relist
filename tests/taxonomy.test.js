import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import {
  TAXONOMY_KEY, TTL,
  flattenCatalogs, findCatalog, optionsFromAttributes, sizesFromAttributes,
  conditionsFromAttributes, parsePriceSuggestion, isFresh,
  lookupCachedCatalogs, createTaxonomy
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

test('sizesFromAttributes: pulls the size set out of the attribute descriptors', () => {
  const body = {
    attributes: [
      { code: 'brand', value_ids: null, configuration: null },
      {
        code: 'size',
        configuration: {
          options: [
            { id: 102, title: 'XXS / 32 / 4' },
            { id: 103, title: 'XS / 34 / 6' }
          ]
        }
      }
    ]
  };
  assert.deepEqual(sizesFromAttributes(body), [
    { id: 102, title: 'XXS / 32 / 4' },
    { id: 103, title: 'XS / 34 / 6' }
  ]);
});

test('sizesFromAttributes: a category without sizes yields an empty list, not a throw', () => {
  assert.deepEqual(sizesFromAttributes({ attributes: [{ code: 'brand' }] }), []);
  assert.deepEqual(sizesFromAttributes({}), []);
  assert.deepEqual(sizesFromAttributes(null), []);
});

test('conditionsFromAttributes: the condition list comes from Vinted, with its own ids', () => {
  // Deliberately not a table in our code: the ids were never measured, the wording is
  // per-locale, and a wrong condition is legally binding (§7.5).
  const body = {
    attributes: [
      { code: 'size', configuration: { options: [{ id: 102, title: 'M' }] } },
      {
        code: 'status',
        configuration: {
          options: [
            { id: 1, title: 'Neu mit Etikett' },
            { id: 2, title: 'Sehr gut' }
          ]
        }
      }
    ]
  };
  assert.deepEqual(conditionsFromAttributes(body), [
    { id: 1, title: 'Neu mit Etikett' },
    { id: 2, title: 'Sehr gut' }
  ]);
  // The same response answers both — one request, two lists.
  assert.deepEqual(sizesFromAttributes(body), [{ id: 102, title: 'M' }]);
});

test('optionsFromAttributes: an unknown attribute code is empty, not a throw', () => {
  assert.deepEqual(optionsFromAttributes({ attributes: [{ code: 'size' }] }, 'status'), []);
  assert.deepEqual(optionsFromAttributes(null, 'status'), []);
});

test('conditions: cached per category like the sizes', async () => {
  const fetchJson = fakeTransport({
    '/api/v2/item_upload/attributes': {
      attributes: [{ code: 'status', configuration: { options: [{ id: 2, title: 'Sehr gut' }] } }]
    }
  });
  const taxonomy = createTaxonomy({ fetchJson });
  assert.deepEqual(await taxonomy.conditions(196), [{ id: 2, title: 'Sehr gut' }]);
  await taxonomy.conditions(196);
  assert.equal(fetchJson.calls.length, 1);
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
  const answer = (path, options) => ({
    attributes: [{
      code: 'size',
      configuration: { options: [{ id: JSON.parse(options.body).attributes[0].value[0], title: 'M' }] }
    }]
  });
  const fetchJson = fakeTransport({ '/api/v2/item_upload/attributes': answer });
  const taxonomy = createTaxonomy({ fetchJson });

  const a = await taxonomy.sizes(196);
  const b = await taxonomy.sizes(196);
  const c = await taxonomy.sizes(1807);
  assert.equal(fetchJson.calls.length, 2, 'same category cached, different category fetched');
  assert.deepEqual(a, b);
  assert.equal(a[0].id, 196);
  assert.equal(c[0].id, 1807);
});

test('requiredFields: asked at runtime, never hardcoded', async () => {
  const fetchJson = fakeTransport({
    '/api/v2/offline_verification/criteria/': { required_field_codes: ['brand', 'price'], code: 0 }
  });
  const taxonomy = createTaxonomy({ fetchJson });
  assert.deepEqual(await taxonomy.requiredFields(196), ['brand', 'price']);
  assert.match(fetchJson.calls[0].path, /criteria\/196$/);
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

test('packageSize: Vinted recommends the parcel size, so it is not guessed either', async () => {
  const fetchJson = fakeTransport({
    '/shipping-estimation/external/package_sizes/suggestion': { package_size_id: 2 }
  });
  const taxonomy = createTaxonomy({ fetchJson });
  const id = await taxonomy.packageSize({ catalogId: 196, brandId: 53, sizeId: 102, uploadSessionId: 'u-1' });
  assert.equal(id, 2);

  const body = JSON.parse(fetchJson.calls[0].body);
  assert.equal(body.catalog_id, 196);
  assert.equal(body.size_id, 102);
  assert.equal(body.upload_session_id, 'u-1');
});

test('packageSize: no recommendation means null, never a default parcel', async () => {
  const fetchJson = fakeTransport({ '/shipping-estimation/external/package_sizes/suggestion': {} });
  assert.equal(await createTaxonomy({ fetchJson }).packageSize({ catalogId: 196, uploadSessionId: 'u-1' }), null);
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
