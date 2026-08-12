import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relist, preflight } from '../lib/relist.js';
import { ApiError, RateLimitError } from '../lib/errors.js';
import { GATE_FIRST_RUN, GATE_COOLDOWN, GATE_INTEREST } from '../lib/gates.js';
import { makeFakePort, SOURCE_ITEM, NEW_ITEM_ID, UPLOAD_SESSION_ID } from './helpers/fake-port.js';

/**
 * The relist pipeline, driven through its port.
 *
 * The invariant every failure-path test below exists to protect:
 *   THE ORIGINAL IS NEVER DELETED UNLESS A NEW LISTING WAS CREATED AND CONFIRMED.
 * So most of these assert `port.countOf('deleteItem') === 0`.
 */

const URL = 'https://www.vinted.de/items/111-lego-technic';
const DOMAIN = 'www.vinted.de';

/** A Vinted validation_error response body. */
const validationBody = (field, value) =>
  JSON.stringify({ message_code: 'validation_error', errors: [{ field, value }] });

// ====================================================================================
// Happy path
// ====================================================================================

test('happy path: creates, verifies, then deletes — in that order', async () => {
  const port = makeFakePort();
  const res = await relist(URL, port);

  assert.deepEqual(res, {
    oldId: '111',
    newId: NEW_ITEM_ID,
    newUrl: `https://${DOMAIN}/items/${NEW_ITEM_ID}`
  });

  const api = port.names.filter(n => ['fetchItem', 'uploadPhoto', 'createItem', 'deleteItem'].includes(n));
  assert.deepEqual(api, [
    'fetchItem',    // 1. read the source
    'uploadPhoto',  // 2. re-upload each photo
    'uploadPhoto',
    'createItem',   // 3. create the clone
    'fetchItem',    // 4. verify it
    'deleteItem'    // 5. only now delete the original
  ]);
  assert.deepEqual(port.deleted, ['111']);
});

test('happy path: records history and drives progress to 100', async () => {
  const port = makeFakePort();
  await relist(URL, port);

  assert.deepEqual(port.history, [{
    oldId: '111', newId: String(NEW_ITEM_ID), title: SOURCE_ITEM.title, domain: DOMAIN, testMode: false
  }]);
  assert.equal(port.progress.at(-1).pct, 100);
  assert.equal(port.progress.at(-1).label, 'Fertig.');
  assert.ok(port.progress.every(p => p.pct >= 0 && p.pct <= 100));
});

test('happy path: every photo is downloaded, re-encoded and uploaded under one session id', async () => {
  const port = makeFakePort();
  await relist(URL, port);

  assert.equal(port.countOf('downloadPhoto'), 2);
  assert.equal(port.countOf('encodePhoto'), 2);
  assert.equal(port.countOf('uploadPhoto'), 2);

  assert.deepEqual(port.argsOf('downloadPhoto', 0), ['https://images1.vinted.net/a.jpg']);
  assert.deepEqual(port.argsOf('downloadPhoto', 1), ['https://images1.vinted.net/b.jpg']);
  assert.deepEqual(port.uploads.map(u => u.filename), ['photo_0.jpg', 'photo_1.jpg']);
  assert.deepEqual(port.uploads.map(u => u.tempUuid), [UPLOAD_SESSION_ID, UPLOAD_SESSION_ID]);
  assert.equal(port.argsOf('encodePhoto', 0)[1], port.settings.photoQuality);
});

test('happy path: create payload carries the session id and per-photo orientation', async () => {
  const port = makeFakePort();
  await relist(URL, port);

  const [payload] = port.createPayloads;
  assert.equal(payload.upload_session_id, UPLOAD_SESSION_ID);
  assert.equal(payload.item.temp_uuid, UPLOAD_SESSION_ID);
  assert.deepEqual(payload.item.assigned_photos, [
    { id: 1000, orientation: 0 },
    { id: 1001, orientation: 1 }
  ]);
});

// ====================================================================================
// Create failures — the original must survive every one of them
// ====================================================================================

test('create fails with 5xx: retried, then throws — original NOT deleted', async () => {
  const port = makeFakePort({ createItem: () => { throw new ApiError(503, 'boom'); } });
  await assert.rejects(() => relist(URL, port), /HTTP 503/);
  assert.equal(port.countOf('createItem'), 3, 'withRetry gives it three attempts');
  assert.equal(port.countOf('deleteItem'), 0);
});

test('create fails with a plain 4xx: no retry, throws — original NOT deleted', async () => {
  const port = makeFakePort({ createItem: () => { throw new ApiError(422, 'nope'); } });
  await assert.rejects(() => relist(URL, port), /HTTP 422/);
  assert.equal(port.countOf('createItem'), 1);
  assert.equal(port.countOf('deleteItem'), 0);
});

test('create is rate-limited then succeeds: backoff runs on the port clock', async () => {
  let calls = 0;
  const port = makeFakePort({
    createItem: (domain, auth, payload) => {
      if (++calls < 3) throw new RateLimitError('slow down');
      port.createPayloads.push(structuredClone(payload));
      port.created.set(String(NEW_ITEM_ID), { id: NEW_ITEM_ID, photos: payload.item.assigned_photos });
      return { id: NEW_ITEM_ID };
    }
  });
  const res = await relist(URL, port);
  assert.equal(res.newId, NEW_ITEM_ID);
  assert.equal(calls, 3);
  assert.ok(port.sleeps.includes(2000), 'first backoff was requested');
  assert.ok(port.sleeps.includes(5000), 'second, longer backoff was requested');
});

test('anti-bot block is surfaced as a friendly BotBlocked error — nothing is deleted', async () => {
  const port = makeFakePort({
    fetchItem: () => { throw new ApiError(403, '<html>captcha-delivery datadome</html>'); }
  });
  await assert.rejects(() => relist(URL, port), (e) => {
    assert.equal(e.name, 'BotBlocked');
    assert.match(e.message, /Anti-Bot-Schutz/);
    return true;
  });
  assert.equal(port.countOf('createItem'), 0);
  assert.equal(port.countOf('deleteItem'), 0);
});

// ====================================================================================
// Colour auto-recovery
// ====================================================================================

test('colour validation error on a colourless item: retries once with the default colour', async () => {
  let calls = 0;
  const source = { ...structuredClone(SOURCE_ITEM), color1_id: null, color2_id: null };
  const port = makeFakePort({
    source,
    createItem: (domain, auth, payload) => {
      port.createPayloads.push(structuredClone(payload));
      if (++calls === 1) throw new ApiError(400, validationBody('color', 'Wähle ein Farbe'));
      port.created.set(String(NEW_ITEM_ID), { id: NEW_ITEM_ID, photos: payload.item.assigned_photos });
      return { id: NEW_ITEM_ID };
    }
  });

  const res = await relist(URL, port);
  assert.equal(res.newId, NEW_ITEM_ID);
  assert.equal(calls, 2, 'exactly one retry');

  assert.deepEqual(port.createPayloads[0].item.color_ids, [], 'first attempt had no colour');
  assert.deepEqual(port.createPayloads[1].item.color_ids, [15], 'retry injected the default');
  assert.equal(port.createPayloads[1].item.color1_id, 15);
  assert.deepEqual(port.deleted, ['111'], 'the recovered run still completes');
});

test('colour retry honours a configured defaultColorId', async () => {
  let calls = 0;
  const port = makeFakePort({
    settings: { defaultColorId: 12 },
    source: { ...structuredClone(SOURCE_ITEM), color1_id: null, color2_id: null },
    createItem: (domain, auth, payload) => {
      port.createPayloads.push(structuredClone(payload));
      if (++calls === 1) throw new ApiError(400, validationBody('color', 'Wähle ein Farbe'));
      port.created.set(String(NEW_ITEM_ID), { id: NEW_ITEM_ID, photos: payload.item.assigned_photos });
      return { id: NEW_ITEM_ID };
    }
  });
  await relist(URL, port);
  assert.deepEqual(port.createPayloads[1].item.color_ids, [12]);
});

test('colour error twice: friendly ValidationError, original NOT deleted', async () => {
  const port = makeFakePort({
    source: { ...structuredClone(SOURCE_ITEM), color1_id: null, color2_id: null },
    createItem: () => { throw new ApiError(400, validationBody('color', 'Wähle ein Farbe')); }
  });
  await assert.rejects(() => relist(URL, port), (e) => {
    assert.equal(e.name, 'ValidationError');
    assert.match(e.message, /color: Wähle ein Farbe/);
    assert.match(e.message, /NICHT gelöscht/);
    return true;
  });
  assert.equal(port.countOf('createItem'), 2);
  assert.equal(port.countOf('deleteItem'), 0);
});

test('colour error on an item that already HAS a colour: no retry', async () => {
  const port = makeFakePort({
    createItem: () => { throw new ApiError(400, validationBody('color', 'Wähle ein Farbe')); }
  });
  await assert.rejects(() => relist(URL, port), /color: Wähle ein Farbe/);
  assert.equal(port.countOf('createItem'), 1, 'auto-fix must not fire when a colour was sent');
  assert.equal(port.countOf('deleteItem'), 0);
});

test('a non-colour validation error is surfaced verbatim, never retried', async () => {
  const port = makeFakePort({
    createItem: () => { throw new ApiError(400, validationBody('size', 'Größe fehlt')); }
  });
  await assert.rejects(() => relist(URL, port), /size: Größe fehlt/);
  assert.equal(port.countOf('createItem'), 1);
  assert.equal(port.countOf('deleteItem'), 0);
});

// ====================================================================================
// The verify gate
// ====================================================================================

test('verification returns zero photos: partial result, original NOT deleted', async () => {
  const port = makeFakePort({
    fetchItem: (domain, auth, itemId) =>
      String(itemId) === '111' ? structuredClone(SOURCE_ITEM) : { id: NEW_ITEM_ID, photos: [] }
  });
  const res = await relist(URL, port);
  assert.equal(res.partial, true);
  assert.equal(res.newId, NEW_ITEM_ID);
  assert.match(res.warning, /Original NICHT gelöscht/);
  assert.equal(port.countOf('deleteItem'), 0);
});

test('verification never succeeds: partial result after every attempt, original NOT deleted', async () => {
  const port = makeFakePort({
    fetchItem: (domain, auth, itemId) => {
      if (String(itemId) === '111') return structuredClone(SOURCE_ITEM);
      throw new ApiError(404, 'not yet');
    }
  });
  const res = await relist(URL, port);
  assert.equal(res.partial, true);
  assert.match(res.warning, /konnte aber nicht verifiziert werden/);
  assert.equal(port.countOf('fetchItem'), 5, 'source fetch + four verify attempts');
  assert.deepEqual(port.sleeps.filter(ms => [1500, 2500, 4000, 5500].includes(ms)), [1500, 2500, 4000, 5500]);
  assert.equal(port.countOf('deleteItem'), 0);
});

test('verification retries and succeeds on a later attempt: the delete proceeds', async () => {
  let verifyCalls = 0;
  const port = makeFakePort({
    fetchItem: (domain, auth, itemId) => {
      if (String(itemId) === '111') return structuredClone(SOURCE_ITEM);
      if (++verifyCalls < 3) throw new ApiError(404, 'not yet');
      return { id: NEW_ITEM_ID, photos: [{ id: 1000 }] };
    }
  });
  const res = await relist(URL, port);
  assert.equal(res.partial, undefined);
  assert.deepEqual(port.deleted, ['111']);
});

test('verifyAfterCreate=false skips verification but still deletes', async () => {
  const port = makeFakePort({ settings: { verifyAfterCreate: false } });
  const res = await relist(URL, port);
  assert.equal(port.countOf('fetchItem'), 1, 'only the source fetch');
  assert.equal(res.newId, NEW_ITEM_ID);
  assert.deepEqual(port.deleted, ['111']);
});

// ====================================================================================
// The ownership gate
// ====================================================================================

test('ownership mismatch: partial result, original NOT deleted', async () => {
  const port = makeFakePort({ vUid: '9999' }); // source item belongs to 4242
  const res = await relist(URL, port);
  assert.equal(res.partial, true);
  assert.match(res.warning, /Ownership mismatch/);
  assert.equal(port.countOf('deleteItem'), 0);
  assert.deepEqual(port.history, [], 'an aborted run is not recorded');
});

test('ownership gate falls back open when v_uid is unknown', async () => {
  const port = makeFakePort({ vUid: null });
  const res = await relist(URL, port);
  assert.equal(res.partial, undefined);
  assert.deepEqual(port.deleted, ['111']);
});

test('ownership gate reads seller_id when user_id is absent', async () => {
  const source = structuredClone(SOURCE_ITEM);
  delete source.user_id;
  source.seller_id = 9999;
  const port = makeFakePort({ source, vUid: '4242' });
  const res = await relist(URL, port);
  assert.equal(res.partial, true);
  assert.equal(port.countOf('deleteItem'), 0);
});

// ====================================================================================
// Test mode and delete failure
// ====================================================================================

test('test mode: creates the clone, keeps the original, records the run', async () => {
  const port = makeFakePort({ settings: { deleteEnabled: false } });
  const res = await relist(URL, port);

  assert.equal(res.testMode, true);
  assert.equal(res.oldUrl, `https://${DOMAIN}/items/111`);
  assert.equal(res.newUrl, `https://${DOMAIN}/items/${NEW_ITEM_ID}`);
  assert.equal(port.countOf('deleteItem'), 0);
  assert.equal(port.countOf('fetchItem'), 1, 'no verification in test mode');
  assert.equal(port.history[0].testMode, true);
});

test('delete fails: partial result with a manual-cleanup warning, run not recorded', async () => {
  const port = makeFakePort({ deleteItem: () => { throw new ApiError(500, 'nope'); } });
  const res = await relist(URL, port);

  assert.equal(res.partial, true);
  assert.equal(res.newId, NEW_ITEM_ID);
  assert.match(res.warning, /deleting the original failed/);
  assert.equal(port.countOf('deleteItem'), 3, 'a 5xx delete is retried');
  assert.deepEqual(port.history, [], 'history only records a completed relist');
});

// ====================================================================================
// Guards before anything destructive happens
// ====================================================================================

test('missing CSRF token: throws before touching the API', async () => {
  const port = makeFakePort({ auth: { csrf: null } });
  await assert.rejects(() => relist(URL, port), /Could not find CSRF token/);
  assert.equal(port.countOf('fetchItem'), 0);
});

test('missing anon_id: throws before touching the API', async () => {
  const port = makeFakePort({ auth: { anonId: null } });
  await assert.rejects(() => relist(URL, port), /Missing anon_id cookie/);
  assert.equal(port.countOf('fetchItem'), 0);
});

test('source listing has no photos: throws before creating anything', async () => {
  const port = makeFakePort({ source: { ...structuredClone(SOURCE_ITEM), photos: [] } });
  await assert.rejects(() => relist(URL, port), /Source listing has no photos/);
  assert.equal(port.countOf('createItem'), 0);
  assert.equal(port.countOf('deleteItem'), 0);
});

test('a photo with no usable URL aborts before creating anything', async () => {
  const source = structuredClone(SOURCE_ITEM);
  source.photos = [{ nothing: true }];
  const port = makeFakePort({ source });
  await assert.rejects(() => relist(URL, port), /Photo 0 has no URL/);
  assert.equal(port.countOf('createItem'), 0);
  assert.equal(port.countOf('deleteItem'), 0);
});

test('a non-Vinted URL is rejected before any port call', async () => {
  const port = makeFakePort();
  await assert.rejects(() => relist('https://example.com/items/1', port), /Not a Vinted URL/);
  assert.equal(port.countOf('ensureAuth'), 0);
});

test('photo download failure aborts before creating anything', async () => {
  const port = makeFakePort({ downloadPhoto: () => { throw new Error('Photo fetch failed: 404'); } });
  await assert.rejects(() => relist(URL, port), /Photo fetch failed/);
  assert.equal(port.countOf('createItem'), 0);
  assert.equal(port.countOf('deleteItem'), 0);
});

// ====================================================================================
// preflight — non-destructive by construction
// ====================================================================================

test('preflight: reports title, photo count, interest and cooldown counts', async () => {
  const port = makeFakePort({ counts: { lastHour: 2, last24h: 7, total: 9 } });
  const pre = await preflight(URL, port);

  assert.equal(pre.title, SOURCE_ITEM.title);
  assert.equal(pre.photoCount, 2);
  assert.deepEqual(pre.interest, { favourites: 3, views: 41, conversations: 1 });
  assert.deepEqual(pre.counts, { lastHour: 2, last24h: 7, total: 9 });
});

test('preflight: gates are derived from the item, the counts and the settings', async () => {
  // The fixture item has favourites/views/chats, so the interest gate fires.
  const port = makeFakePort();
  const pre = await preflight(URL, port);
  assert.deepEqual(pre.gates.map(g => g.kind), [GATE_INTEREST]);
  assert.deepEqual(pre.gates[0].lines, ['Favoriten: 3', 'Aufrufe: 41', 'Gespräche: 1']);
});

test('preflight: an unconfirmed install gets the first-run gate first', async () => {
  const port = makeFakePort({ confirmedDelete: false });
  const pre = await preflight(URL, port);
  assert.deepEqual(pre.gates.map(g => g.kind), [GATE_FIRST_RUN, GATE_INTEREST]);
});

test('preflight: a heavily-used account also gets the cooldown gate', async () => {
  const port = makeFakePort({ counts: { lastHour: 6, last24h: 40 } });
  const pre = await preflight(URL, port);
  assert.deepEqual(pre.gates.map(g => g.kind), [GATE_COOLDOWN, GATE_INTEREST]);
});

test('preflight: a quiet item on a confirmed install raises no gate', async () => {
  const source = structuredClone(SOURCE_ITEM);
  source.favourite_count = 0; source.view_count = 0; source.conversation_count = 0;
  const port = makeFakePort({ source });
  const pre = await preflight(URL, port);
  assert.deepEqual(pre.gates, []);
});

test('preflight never creates, uploads or deletes', async () => {
  const port = makeFakePort();
  await preflight(URL, port);
  assert.deepEqual(port.names, ['ensureAuth', 'fetchItem', 'relistCounts', 'getSettings', 'hasConfirmedDelete']);
});

test('preflight: incomplete session throws before fetching', async () => {
  const port = makeFakePort({ auth: { csrf: null } });
  await assert.rejects(() => preflight(URL, port), /Sitzung unvollständig/);
  assert.equal(port.countOf('fetchItem'), 0);
});

// ====================================================================================
// Vinted renamed a field we must replay (observed live 2026-08-12)
// ====================================================================================

/** A source item as Vinted returned it on 2026-08-12: no condition, no size. */
function sourceWithoutConditionOrSize() {
  const src = structuredClone(SOURCE_ITEM);
  delete src.status_id;
  delete src.size_id;
  return src;
}

const CONDITION_SIZE_REJECTION = () => {
  throw new ApiError(400, JSON.stringify({
    code: 99, message: 'Es gibt ein Problem', message_code: 'validation_error',
    errors: [
      { field: 'condition', value: 'Wähle ein Zustand, um fortzufahren' },
      { field: 'size', value: 'Wähle ein Größe, um fortzufahren' }
    ]
  }));
};

test('unreadable condition/size: the original is NOT deleted', async () => {
  const port = makeFakePort({ source: sourceWithoutConditionOrSize(), createItem: CONDITION_SIZE_REJECTION });
  await assert.rejects(() => relist(URL, port));
  assert.equal(port.countOf('deleteItem'), 0, 'nothing may be deleted when create fails');
});

test('unreadable condition/size: the message blames the API, not the listing', async () => {
  // The old message told the user to go fill in a field their listing already had.
  const port = makeFakePort({ source: sourceWithoutConditionOrSize(), createItem: CONDITION_SIZE_REJECTION });
  await assert.rejects(() => relist(URL, port), e => {
    assert.match(e.message, /API-Feldnamen geändert/);
    assert.doesNotMatch(e.message, /ergänze das fehlende Feld/);
    assert.match(e.message, /condition: Wähle ein Zustand/);
    assert.match(e.message, /NICHT gelöscht/);
    return true;
  });
});

test('a field the user really did leave blank still says so', async () => {
  // Same rejection, but the payload DID carry a condition — so this one is on the listing.
  const port = makeFakePort({
    source: SOURCE_ITEM, // has status_id + size_id
    createItem: () => {
      throw new ApiError(400, JSON.stringify({
        message_code: 'validation_error',
        errors: [{ field: 'measurement_length', value: 'Pflichtfeld' }]
      }));
    }
  });
  await assert.rejects(() => relist(URL, port), e => {
    assert.match(e.message, /ergänze das fehlende Feld/);
    assert.doesNotMatch(e.message, /API-Feldnamen/);
    return true;
  });
});

test('a rejected create logs the source values the field could have come from', async () => {
  // Fires only on a rejection: this is what identifies a renamed or newly-required field
  // from a copied log, without inspecting a live API response.
  const src = sourceWithoutConditionOrSize();
  src.status = 'Sehr gut';                              // a label we refuse to guess at
  src.item_attributes = [{ code: 'condition', ids: [2] }];
  const port = makeFakePort({ source: src, createItem: CONDITION_SIZE_REJECTION });
  await assert.rejects(() => relist(URL, port));

  const probe = port.calls.find(c => c.name === 'log' && c.args[0] === 'create_rejected_probe');
  assert.ok(probe, 'a create_rejected_probe line must be logged');
  assert.equal(probe.args[1].rejected, 'condition,size');
  assert.match(probe.args[1].probe, /"status":"Sehr gut"/);
  assert.match(probe.args[1].probe, /item_attributes/);
});

test('an item that legitimately has no size produces no diagnostic noise', async () => {
  // A comic has no size and needs none. The old pre-create check logged a scary
  // "missing fields" line for exactly this case.
  const src = structuredClone(SOURCE_ITEM);
  src.size_id = null;
  const port = makeFakePort({ source: src });
  await relist(URL, port);
  assert.ok(!port.calls.some(c => c.name === 'log' && String(c.args[0]).includes('probe')));
});


test('a source carrying its size in item_attributes relists successfully', async () => {
  // If that is where Vinted moved it, the pipeline now completes with no further change.
  const src = sourceWithoutConditionOrSize();
  src.status = 2;
  src.item_attributes = [{ code: 'size', ids: [620] }];
  const port = makeFakePort({ source: src });

  const res = await relist(URL, port);
  assert.equal(res.newId, NEW_ITEM_ID);
  assert.equal(port.createPayloads[0].item.status_id, 2);
  assert.equal(port.createPayloads[0].item.size_id, 620);
  assert.ok(!port.calls.some(c => c.name === 'log' && c.args[0] === 'fetchItem_probe'),
    'nothing is unreadable, so no probe is logged');
});

// ====================================================================================
// Single flight — the "one relist at a time" invariant
// ====================================================================================

test('a second relist started while one is running is rejected with BusyError', async () => {
  // The guard used to be a per-tab boolean in the content script, so two tabs — or a tab
  // plus the popup — could run concurrently, interleaving progress and skipping cooldown.
  let release;
  const gate = new Promise(r => { release = r; });
  const first = makeFakePort({ createItem: async (domain, auth, payload) => {
    await gate;
    first.createPayloads.push(structuredClone(payload));
    first.created.set(String(NEW_ITEM_ID), { id: NEW_ITEM_ID, photos: payload.item.assigned_photos });
    return { id: NEW_ITEM_ID };
  } });

  const running = relist(URL, first);
  const second = makeFakePort();
  await assert.rejects(() => relist(URL, second), e => {
    assert.equal(e.name, 'BusyError');
    return true;
  });
  // The rejected call must not have touched anything at all.
  assert.deepEqual(second.names, [], 'a busy rejection does no work');

  release();
  await running;
});

test('the lock is released after a successful run', async () => {
  await relist(URL, makeFakePort());
  const res = await relist(URL, makeFakePort());
  assert.equal(res.newId, NEW_ITEM_ID, 'a later relist runs normally');
});

test('the lock is released after a failed run', async () => {
  await assert.rejects(() => relist(URL, makeFakePort({ createItem: () => { throw new ApiError(422, 'no'); } })));
  const res = await relist(URL, makeFakePort());
  assert.equal(res.newId, NEW_ITEM_ID, 'a failure must not wedge the lock shut');
});

test('preflight is not blocked by a running relist — it is non-destructive', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const port = makeFakePort({ createItem: async (domain, auth, payload) => {
    await gate;
    port.created.set(String(NEW_ITEM_ID), { id: NEW_ITEM_ID, photos: payload.item.assigned_photos });
    return { id: NEW_ITEM_ID };
  } });

  const running = relist(URL, port);
  const pre = await preflight(URL, makeFakePort());
  assert.equal(pre.title, SOURCE_ITEM.title);
  release();
  await running;
});

test('a book language set on the original survives the relist', async () => {
  // The live failure: `language_book: Wähle eine Sprache`. The user's language was in
  // item_attributes and we were dropping it, so setting it on the original could never help.
  const src = structuredClone(SOURCE_ITEM);
  src.item_attributes = [{ code: 'condition', ids: [2] }, { code: 'language_book', ids: [7] }];
  const port = makeFakePort({ source: src });

  await relist(URL, port);
  assert.deepEqual(port.createPayloads[0].item.item_attributes, src.item_attributes);
});

test('a validation failure points the user at the edit page', async () => {
  // Vinted requires new fields on old listings, so "go fix your listing" is only useful
  // with a link to the listing.
  const port = makeFakePort({
    createItem: () => { throw new ApiError(400, validationBody('language_book', 'Wähle eine Sprache')); }
  });
  await assert.rejects(() => relist(URL, port), e => {
    assert.match(e.message, /language_book: Wähle eine Sprache/);
    assert.match(e.message, /Hier bearbeiten: https:\/\/www\.vinted\.de\/items\/111\/edit/);
    return true;
  });
  assert.equal(port.countOf('deleteItem'), 0);
});

test('an unreadable-field failure does NOT send the user to the edit page', async () => {
  // Nothing there for them to fix — the advice is to report the log instead.
  const src = sourceWithoutConditionOrSize();
  const port = makeFakePort({ source: src, createItem: CONDITION_SIZE_REJECTION });
  await assert.rejects(() => relist(URL, port), e => {
    assert.doesNotMatch(e.message, /Hier bearbeiten/);
    assert.match(e.message, /API-Feldnamen/);
    return true;
  });
});
