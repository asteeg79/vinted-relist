import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import {
  PRICE_MEMORY_KEY, memoryKey, broadKey, recallPrice, rememberPrice, loadPriceMemory, savePrice
} from '../lib/price-memory.js';

const hoodie = { categoryGroup: 'clothing', brand: 'Nike', type: 'Hoodie' };

beforeEach(() => installChromeMock());

// ---------- keys ----------

test('memoryKey: same article, same key — whatever the spelling', () => {
  assert.equal(
    memoryKey(hoodie),
    memoryKey({ categoryGroup: 'clothing', brand: '  NIKE ', type: 'hoodie' })
  );
});

test('memoryKey: different brand or type, different key', () => {
  assert.notEqual(memoryKey(hoodie), memoryKey({ ...hoodie, brand: 'Adidas' }));
  assert.notEqual(memoryKey(hoodie), memoryKey({ ...hoodie, type: 'T-Shirt' }));
});

test('memoryKey: survives a draft with nothing recognised yet', () => {
  assert.equal(typeof memoryKey(), 'string');
  assert.equal(typeof memoryKey({}), 'string');
});

test('broadKey: drops the article type, keeps group and brand', () => {
  assert.equal(broadKey(memoryKey(hoodie)), 'clothing|nike|');
});

// ---------- remember / recall ----------

test('remember then recall gives the price back', () => {
  const key = memoryKey(hoodie);
  const store = rememberPrice({}, key, 18);
  assert.equal(recallPrice(store, key).price, 18);
  assert.equal(recallPrice(store, key).match, 'exact');
});

test('recall falls back to the brand when the exact article is new', () => {
  const store = rememberPrice({}, memoryKey(hoodie), 18);
  const jacket = memoryKey({ categoryGroup: 'clothing', brand: 'Nike', type: 'Jacke' });
  const hint = recallPrice(store, jacket);
  assert.equal(hint.price, 18);
  assert.equal(hint.match, 'brand', 'a brand-level hit must say so, not pose as exact');
});

test('recall returns null when nothing comparable was ever sold', () => {
  const store = rememberPrice({}, memoryKey(hoodie), 18);
  assert.equal(recallPrice(store, memoryKey({ categoryGroup: 'shoes', brand: 'Puma', type: 'Sneaker' })), null);
  assert.equal(recallPrice({}, memoryKey(hoodie)), null);
  assert.equal(recallPrice({}, ''), null);
});

test('a later price replaces the earlier one and counts up', () => {
  const key = memoryKey(hoodie);
  let store = rememberPrice({}, key, 18, 1000);
  store = rememberPrice(store, key, 22, 2000);
  const hint = recallPrice(store, key);
  assert.equal(hint.price, 22);
  assert.equal(hint.count, 2);
  assert.equal(hint.ts, 2000);
});

test('nonsense is never remembered', () => {
  const key = memoryKey(hoodie);
  for (const price of [0, -5, NaN, null, undefined, 'teuer']) {
    assert.deepEqual(rememberPrice({}, key, price), {}, `${price} was remembered`);
  }
  assert.deepEqual(rememberPrice({}, '', 18), {});
});

test('the store stays small — the oldest entries drop out', () => {
  let store = {};
  for (let i = 0; i < 260; i++) {
    store = rememberPrice(store, memoryKey({ categoryGroup: 'clothing', brand: 'M' + i, type: 'Hoodie' }), 10 + i, i);
  }
  assert.ok(Object.keys(store).length <= 200, Object.keys(store).length);
  // The newest survived, the oldest did not.
  assert.ok(recallPrice(store, memoryKey({ categoryGroup: 'clothing', brand: 'M259', type: 'Hoodie' })));
  assert.equal(recallPrice(store, memoryKey({ categoryGroup: 'clothing', brand: 'M0', type: 'Hoodie' })), null);
});

test('rememberPrice does not mutate the store it was given', () => {
  const before = {};
  rememberPrice(before, memoryKey(hoodie), 18);
  assert.deepEqual(before, {});
});

// ---------- storage ----------

test('loadPriceMemory: empty when nothing was ever stored', async () => {
  assert.deepEqual(await loadPriceMemory(), {});
});

test('savePrice: persists and reads back', async () => {
  const key = memoryKey(hoodie);
  await savePrice(key, 18);
  const store = await loadPriceMemory();
  assert.equal(recallPrice(store, key).price, 18);
});

test('savePrice: accumulates across calls instead of overwriting the store', async () => {
  await savePrice(memoryKey(hoodie), 18);
  await savePrice(memoryKey({ categoryGroup: 'shoes', brand: 'Puma', type: 'Sneaker' }), 30);
  const store = await loadPriceMemory();
  assert.equal(recallPrice(store, memoryKey(hoodie)).price, 18);
  assert.equal(recallPrice(store, memoryKey({ categoryGroup: 'shoes', brand: 'Puma', type: 'Sneaker' })).price, 30);
});

test('savePrice: stores nothing but prices — no photos, no drafts', async () => {
  const { store } = installChromeMock();
  await savePrice(memoryKey(hoodie), 18);
  const written = JSON.stringify(store[PRICE_MEMORY_KEY]);
  assert.match(written, /"price":18/);
  assert.ok(written.length < 500, written);
});
