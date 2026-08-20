/**
 * Vinteds Taxonomie — Kategorien, Farben, Marken, Größen, Pflichtfelder, Preisspanne.
 *
 * Every path and every response shape in here was measured on `/items/new` during the
 * 0b spike (2026-08-14); they are written down in `docs/TECHNISCHE_DOKUMENTATION.md` §6.
 * Nothing is guessed — a wrong id in a public listing is a warranty case (ADR-0005).
 *
 * THE TRANSPORT IS INJECTED. The spike showed that reads from an extension page succeed
 * with the usual headers, so the studio can call Vinted directly and Stufe 2 needs no open
 * Vinted tab. That is a deployment fact, not a design one — this module takes `fetchJson`
 * and does not care whether it is a direct `fetch` or a `draft/lookup` message. Swapping
 * it back is one line at the wiring site (Entscheidung 15).
 *
 * WHAT IS CACHED AND WHY. The catalog tree is 486 KB and changes on the scale of months;
 * the colour list is 29 entries and just as stable. Sizes hang off a category, so they are
 * cached per category. Brands are deliberately NOT cached — the concept asks for live, and
 * the list is category-specific and short. The price range is never cached: it moves with
 * the condition, and a stale price is worse than one more call.
 */

/** One storage key for the whole taxonomy cache — it is read and written as a unit. */
export const TAXONOMY_KEY = 'taxonomy';

const DAY = 24 * 60 * 60 * 1000;

export const TTL = {
  catalogs: 30 * DAY,
  colors: 30 * DAY,
  sizes: 7 * DAY,
  requiredFields: 7 * DAY
};

// --- pure helpers ---------------------------------------------------------------------

/** Is a cache entry still inside its TTL? A missing or malformed entry never is. */
export function isFresh(entry, now, ttl) {
  return typeof entry?.ts === 'number' && now - entry.ts < ttl;
}

/**
 * Flatten the nested tree into `[{ id, title, path, isLeaf }]`.
 *
 * `path` is the readable trail ("Herren > Kleidung > Bedruckte T-Shirts") — that is what
 * the studio shows next to a suggested category, and what makes an ambiguous suggestion
 * ("Bedruckte" vs "Einfarbige T-Shirts") decidable at a glance.
 */
export function flattenCatalogs(tree) {
  const flat = [];
  (function walk(nodes, trail) {
    for (const node of nodes || []) {
      if (!node || node.id == null) continue;
      const title = node.title || '';
      const path = trail ? `${trail} > ${title}` : title;
      const children = Array.isArray(node.catalogs) ? node.catalogs : [];
      flat.push({ id: node.id, title, path, isLeaf: children.length === 0 });
      walk(children, path);
    }
  })(Array.isArray(tree) ? tree : [], '');
  return flat;
}

/** A node by id, or null. Never a near miss — see ADR-0005. */
export function findCatalog(flat, id) {
  if (id == null) return null;
  return (flat || []).find(c => c.id === id) || null;
}

/**
 * The valid options for one attribute out of an attributes response.
 *
 * Sizes and conditions both live here, and both hang off the category — that is the
 * ordering §6.2 insists on, and Vinted enforces it: the descriptors only exist once a
 * category has been named. Reading them at runtime is also the lesson from the
 * `language_book` incident: which values a category accepts is not ours to hardcode.
 */
export function optionsFromAttributes(body, code) {
  const attribute = (body?.attributes || []).find(a => a?.code === code);
  const options = attribute?.configuration?.options || attribute?.configuration?.values || [];
  return options
    .filter(o => o?.id != null)
    .map(o => ({ id: o.id, title: o.title ?? o.name ?? String(o.id) }));
}

/** The valid size set for a category. */
export const sizesFromAttributes = body => optionsFromAttributes(body, 'size');

/**
 * The valid conditions for a category.
 *
 * Deliberately NOT a hardcoded table of `status_id`s. The ids were never measured, the
 * wording differs per locale, and a wrong condition is legally binding (§7.5) — so the
 * list comes from Vinted, with its real ids, and the studio offers exactly those.
 */
export const conditionsFromAttributes = body => optionsFromAttributes(body, 'status');

const amount = value => {
  const n = Number(value?.amount);
  return Number.isFinite(n) ? n : null;
};

/**
 * Vinteds Preisvorschlag, oder null.
 *
 * Two things worth knowing, both measured: `similar_sold_items_present: false` means there
 * are no comparable sales, and then there is NO suggestion — not a weak one (KONZEPT §7.4,
 * "keine Spanne, kein automatischer Preis"). And `midpoint` is Vinted's own number, not
 * the arithmetic mean: for 4–9 € it says 6, not 6.5. It comes out of their sales data, so
 * it is taken as given rather than recomputed.
 */
export function parsePriceSuggestion(body) {
  if (!body || body.similar_sold_items_present !== true) return null;
  const s = body.price_suggestion;
  if (!s) return null;

  const min = amount(s.minimum);
  const max = amount(s.maximum);
  const midpoint = amount(s.midpoint);
  if (min == null || max == null || midpoint == null) return null;

  return { min, max, midpoint, price: amount(s.price), currency: s.currency || s.minimum?.currency_code || 'EUR', grounded: true };
}

/**
 * Label a handful of category ids from the tree already in the cache.
 *
 * Vinted's photo recognition answers with bare ids; turning them into something a user can
 * choose between needs the tree, and shipping 2910 entries across the message boundary per
 * publish would be absurd. Reads only — an empty answer is fine, `crossCheck` ignores ids
 * it cannot label rather than showing a bare number.
 */
export async function lookupCachedCatalogs(ids) {
  if (!ids?.length) return [];
  const { [TAXONOMY_KEY]: cache } = await chrome.storage.local.get(TAXONOMY_KEY);
  const flat = cache?.catalogs?.value || [];
  return ids.map(id => flat.find(c => c.id === id)).filter(Boolean);
}

// --- the adapter ----------------------------------------------------------------------

/**
 * Build a taxonomy client on an injected transport.
 *
 * `fetchJson(path, options?)` must return the parsed JSON body and throw on a non-2xx —
 * a hole in the taxonomy must surface, never turn into a silent default.
 */
export function createTaxonomy({ fetchJson, now = Date.now } = {}) {
  const readCache = async () => {
    const { [TAXONOMY_KEY]: cache } = await chrome.storage.local.get(TAXONOMY_KEY);
    return cache || {};
  };

  /** Fetch through the cache. Nothing is written when the fetch throws. */
  const cached = async (key, ttl, load) => {
    const cache = await readCache();
    if (isFresh(cache[key], now(), ttl)) return cache[key].value;

    const value = await load();
    const fresh = await readCache(); // re-read: another lookup may have written meanwhile
    fresh[key] = { ts: now(), value };
    await chrome.storage.local.set({ [TAXONOMY_KEY]: fresh });
    return value;
  };

  const post = (path, body) => fetchJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  /** One request answers every attribute of a category — sizes and conditions share it. */
  const attributesFor = categoryId => post('/api/v2/item_upload/attributes', {
    attributes: [{ code: 'category', value: [categoryId] }]
  });

  return {
    /** The whole tree, flattened. 2910 nodes, cached for a month. */
    catalogs: () => cached('catalogs', TTL.catalogs, async () =>
      flattenCatalogs((await fetchJson('/api/v2/item_upload/catalogs')).catalogs)),

    /** Category ids for a keyword. Names come from the tree — this returns ids only. */
    searchCatalogs: async keyword =>
      (await fetchJson(`/api/v2/item_upload/catalogs/search?keyword=${encodeURIComponent(keyword)}`)).catalog_ids || [],

    /** 29 colours, `{ id, title, hex, code }`. */
    colors: () => cached('colors', TTL.colors, async () =>
      (await fetchJson('/api/v2/item_upload/colors')).colors || []),

    /**
     * The popular brands for a category. Live on purpose: the list is short, it is
     * category-specific, and a stale brand id is exactly the mistake ADR-0005 is about.
     * `requires_authenticity_check` rides along — a brand that carries it makes Vinted
     * demand proof photos, and the user has to know before publishing, not after.
     */
    brands: async categoryId =>
      (await fetchJson(`/api/v2/item_upload/brands?category_id=${encodeURIComponent(categoryId)}`)).brands || [],

    /** The valid sizes for one category, cached under that category. */
    sizes: categoryId => cached(`sizes:${categoryId}`, TTL.sizes, async () =>
      sizesFromAttributes(await attributesFor(categoryId))),

    /** The conditions this category offers, with Vinted's own ids. */
    conditions: categoryId => cached(`conditions:${categoryId}`, TTL.sizes, async () =>
      conditionsFromAttributes(await attributesFor(categoryId))),

    /** Which fields Vinted demands for this category — asked, never hardcoded (§6.2). */
    requiredFields: categoryId => cached(`required:${categoryId}`, TTL.requiredFields, async () =>
      (await fetchJson(`/api/v2/offline_verification/criteria/${encodeURIComponent(categoryId)}`)).required_field_codes || []),

    /**
     * The price range. Needs all three ids — the spike showed an incomplete query is
     * answered with `200` and an empty suggestion, so an incomplete draft does not ask.
     * Never cached: the range moves with the condition (4–9 € vs 11–23 € for the same
     * article), which is why a changed condition has to refetch (Entscheidung W3).
     */
    priceSuggestion: async ({ catalogId, brandId, statusId } = {}) => {
      if (catalogId == null || brandId == null || statusId == null) return null;
      const query = new URLSearchParams({ catalog_id: catalogId, brand_id: brandId, status_id: statusId });
      return parsePriceSuggestion(await fetchJson(`/api/v2/item_price_suggestions?${query}`));
    },

    /** Vinted's own parcel-size recommendation, so `package_size_id` isn't guessed either. */
    packageSize: async ({ catalogId, brandId, sizeId, uploadSessionId, title = '', description = '', price = null }) =>
      (await post('/shipping-estimation/external/package_sizes/suggestion', {
        catalog_id: catalogId, brand_id: brandId ?? null, size_id: sizeId ?? null,
        upload_session_id: uploadSessionId, title, description, price
      })).package_size_id ?? null
  };
}
