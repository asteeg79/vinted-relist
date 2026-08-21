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
  conditions: 7 * DAY
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
 * The valid size set for a category, out of a `size_groups` response.
 *
 * MEASURED 2026-08-20, and the measurement corrected an earlier guess. Sizes do NOT ride
 * in the `item_upload/attributes` answer; they come from
 * `/api/v2/item_upload/size_groups`, and the parameter is `catalog_ids[]`, plural and
 * bracketed. Called with `catalog_id` the endpoint answers `200 {"size_groups":[]}` — a
 * success with an empty list, which is why this failed silently instead of throwing: no
 * size ever resolved, and the field simply read "Größe fehlt".
 *
 * A category can return several groups (a shoe has EU and UK). All of them are valid
 * answers, so all of them are offered, deduplicated by id; `resolve.js` splits "M / 38 /
 * 10" on its own.
 */
export function sizesFromGroups(body) {
  const seen = new Set();
  const sizes = [];
  for (const group of body?.size_groups || []) {
    for (const size of group?.sizes || []) {
      if (size?.id == null || seen.has(size.id)) continue;
      seen.add(size.id);
      sizes.push({ id: size.id, title: size.title ?? String(size.id), group: group.description || group.caption || null });
    }
  }
  return sizes;
}

/**
 * The conditions a category offers, out of a `conditions` response.
 *
 * Deliberately NOT a hardcoded table of `status_id`s (ADR-0005) — even though they were
 * measured, and even though all five categories probed on 2026-08-20 returned the same
 * five. `/api/v2/statuses` returns a SIXTH ("Nicht voll funktionsfähig") that the upload
 * list omits, which is exactly the kind of difference that makes a hardcoded table wrong
 * without ever announcing it.
 *
 * `explanation` rides along: it is Vinted's own definition of the stage, and the studio
 * shows it next to the choice so "Sehr gut" is judged by Vinted's yardstick, not by hope.
 */
export function conditionsFromBody(body) {
  return (body?.conditions || body?.statuses || [])
    .filter(c => c?.id != null)
    .map(c => ({ id: c.id, title: c.title ?? String(c.id), explanation: c.explanation ?? null }));
}

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

    /**
     * The valid sizes for one category, cached under that category.
     *
     * `catalog_ids[]` — plural and bracketed. See `sizesFromGroups`: the singular spelling
     * is answered with an empty list rather than an error.
     */
    sizes: categoryId => cached(`sizes:${categoryId}`, TTL.sizes, async () =>
      sizesFromGroups(await fetchJson(`/api/v2/item_upload/size_groups?catalog_ids[]=${encodeURIComponent(categoryId)}`))),

    /** The conditions this category offers, with Vinted's own ids and explanations. */
    conditions: categoryId => cached(`conditions:${categoryId}`, TTL.conditions, async () =>
      conditionsFromBody(await fetchJson(`/api/v2/item_upload/conditions?catalog_id=${encodeURIComponent(categoryId)}`))),

    /**
     * The condition list without a category — the fallback for a draft whose category did
     * not resolve, so the field is at least usable while the category is being sorted out.
     *
     * NOT equivalent to `conditions()`: this list carries one stage more than the upload
     * list does. `lookupDraft` therefore drops a chosen condition that the real
     * per-category list does not contain, once there is one.
     */
    statuses: () => cached('statuses', TTL.conditions, async () =>
      conditionsFromBody(await fetchJson('/api/v2/statuses'))),

    // KEIN `requiredFields` MEHR. `/api/v2/offline_verification/criteria/{id}` sah nach der
    // Pflichtfeldliste der Kategorie aus und ist keine: gemessen am 2026-08-21 antwortet er
    // für elf verschiedene Kategorien — Kleidung, Schuhe, Bücher, Spielzeug — immer
    // `["brand","price"]`, während das Upload-Formular für ein Buch überhaupt kein
    // Markenfeld zeigt. Als Sperre hätte er also genau die Drafts angehalten, die in
    // Ordnung sind. Was eine Kategorie wirklich verlangt, beantwortet
    // `POST /api/v2/item_upload/attributes` — gefragt wird das in `draft.js`, vor dem
    // ersten Upload.

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
    }

    // KEIN `packageSize` MEHR — aus zwei Gründen, beide gemessen am 2026-08-21. Der
    // Versand-Dienst liegt nicht auf der Marktplatz-Domain (`www.vinted.de/shipping-…` ist
    // die 404-Seite, `api.vinted.de/shipping-…` antwortet), und er verträgt die
    // Auth-Header dieses Transports nicht — mit `X-CSRF-Token` scheitert schon der
    // CORS-Preflight. Dazu braucht er die `upload_session_id`, die es während der
    // Vorbereitung noch gar nicht gibt. Er gehört also in den Veröffentlichungsschritt:
    // `page-api.js#suggestPackageSizeViaPage`, gerufen von `draft.js`.
  };
}
