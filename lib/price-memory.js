/**
 * Preis-Gedächtnis — what you charged last time for something like this.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A PRICE ESTIMATE. Vinted's own price range is the
 * better reference and it arrives with Stufe 3 (KONZEPT §7.4), which also forbids falling
 * back to a guess when no range is available. This does not guess: it hands back a price
 * the USER set for a comparable article, labelled as such, as a hint they click to accept.
 * Their own earlier decision is data, not an estimate — and `draftMinPrice` still guards
 * the result either way.
 *
 * It costs no Vinted call, works from the first listing on, and gets better with use.
 * When the real range arrives it becomes the second-best source, not dead code: a range
 * for a category is silent about THIS seller's pricing, and the hint still is not.
 *
 * The pure half (key, recall, remember) is here; the two chrome.storage wrappers at the
 * bottom are the only impure part.
 */

export const PRICE_MEMORY_KEY = 'priceMemory';

/** Beyond this the oldest entries are dropped — the store must stay small and boring. */
const MAX_ENTRIES = 200;

const normalise = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The key an article is remembered under: Warengruppe, Marke, Art.
 *
 * Two levels on purpose. The exact key ("clothing|nike|hoodie") is what a repeat listing
 * hits; the broader one ("clothing|nike") catches the first Nike jacket after three Nike
 * hoodies, where the brand still says more about the price than nothing does.
 */
export function memoryKey({ categoryGroup, brand, type } = {}) {
  return [normalise(categoryGroup) || 'generic', normalise(brand), normalise(type)].join('|');
}

/** The broader key: everything up to the article type. */
export function broadKey(key) {
  const [group, brand] = String(key).split('|');
  return `${group}|${brand}|`;
}

/**
 * The best hint for a key, or null. The exact match wins; without one the brand-level
 * match is offered and says so, so the studio can label it honestly.
 */
export function recallPrice(store = {}, key) {
  if (!key) return null;
  const exact = store[key];
  if (exact?.price > 0) return { ...exact, match: 'exact' };

  const broad = broadKey(key);
  if (broad === key) return null; // there was no article type to drop
  const loose = store[broad];
  return loose?.price > 0 ? { ...loose, match: 'brand' } : null;
}

/**
 * Record a price under both its exact and its brand-level key, and return the new store.
 * Pure — the caller persists it.
 *
 * `count` is kept because a price set five times means more than one set once, and the
 * studio can say so.
 */
export function rememberPrice(store = {}, key, price, now = Date.now()) {
  const value = Number(price);
  if (!key || !Number.isFinite(value) || value <= 0) return store;

  const next = { ...store };
  for (const target of new Set([key, broadKey(key)])) {
    const previous = next[target];
    next[target] = {
      price: value,
      count: (previous?.count || 0) + 1,
      ts: now
    };
  }
  return prune(next);
}

/** Keep the newest MAX_ENTRIES. A price memory is a convenience, not an archive. */
function prune(store) {
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return store;
  const keep = keys
    .sort((a, b) => (store[b].ts || 0) - (store[a].ts || 0))
    .slice(0, MAX_ENTRIES);
  return Object.fromEntries(keep.map(key => [key, store[key]]));
}

// --- adapters -------------------------------------------------------------------------

export async function loadPriceMemory() {
  const { [PRICE_MEMORY_KEY]: store } = await chrome.storage.local.get(PRICE_MEMORY_KEY);
  return store || {};
}

export async function savePrice(key, price) {
  const store = rememberPrice(await loadPriceMemory(), key, price);
  await chrome.storage.local.set({ [PRICE_MEMORY_KEY]: store });
  return store;
}
