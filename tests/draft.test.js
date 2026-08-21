import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { publishDraft } from '../lib/draft.js';
import { makeFakeDraftPort, READY_DRAFT, PHOTOS } from './helpers/fake-draft-port.js';
import { missingMembers } from '../lib/draft-port.js';
import { describeDraftOutcome } from '../lib/gates.js';
import { conflictedFields } from '../lib/draft-view.js';
import { liveDraftPort } from '../lib/live-draft-port.js';
import { resetWriteLock, currentWriter } from '../lib/write-lock.js';
import { ApiError, BusyError, ValidationError } from '../lib/errors.js';

const request = (over = {}) => ({
  domain: 'www.vinted.de',
  draft: READY_DRAFT,
  photos: PHOTOS,
  ...over
});

beforeEach(() => resetWriteLock());

// ---------- the conformance of both adapters ----------

test('both adapters satisfy the DraftPort interface', () => {
  assert.deepEqual(missingMembers(liveDraftPort), []);
  assert.deepEqual(missingMembers(makeFakeDraftPort()), []);
});

// ================================================================================
// THE test of this feature: an open field never reaches createItem.
// ================================================================================

test('a draft with a MISSING field never reaches createItem', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  const draft = { ...READY_DRAFT, price: null };

  await assert.rejects(() => publishDraft(request({ draft }), port), ValidationError);
  assert.equal(port.called('createItem'), false);
  assert.equal(port.called('uploadPhoto'), false, 'not even a photo goes up');
});

test('a draft with an UNCONFIRMED field never reaches createItem', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  // Nothing is missing — the condition simply was not confirmed.
  const draft = { ...READY_DRAFT, confirmations: {} };

  await assert.rejects(() => publishDraft(request({ draft }), port), ValidationError);
  assert.equal(port.called('createItem'), false);
  assert.equal(port.called('uploadPhoto'), false);
});

test('a draft with an AMBIGUOUS field never reaches createItem', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  const draft = {
    ...READY_DRAFT,
    resolved: {
      ...READY_DRAFT.resolved,
      catalog: { id: null, label: 'T-Shirts', confidence: 0, candidates: [{ id: 1, label: 'a' }, { id: 2, label: 'b' }] }
    }
  };

  await assert.rejects(() => publishDraft(request({ draft }), port), ValidationError);
  assert.equal(port.called('createItem'), false);
});

test('the studio cannot lie about being ready — the view is recomputed here', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  // The UI is the untested zone, so a flag it sends carries no authority whatsoever.
  const draft = { ...READY_DRAFT, price: null, canPublish: true };

  await assert.rejects(() => publishDraft(request({ draft }), port), ValidationError);
  assert.equal(port.called('createItem'), false);
});

test('no photos, no upload and no create', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  await assert.rejects(() => publishDraft(request({ photos: [] }), port), /Foto/);
  assert.equal(port.called('uploadPhoto'), false);
});

// ================================================================================
// The dry run is the default.
// ================================================================================

test('with draftCreateEnabled off, createItem is never called', async () => {
  const port = makeFakeDraftPort(); // the default IS the dry run
  const result = await publishDraft(request(), port);

  assert.equal(result.dryRun, true);
  assert.equal(port.called('createItem'), false);
  assert.ok(result.payload.item.title.length);
});

test('the dry run still uploads the photos and builds the whole payload', async () => {
  // That is the point: everything is measurable at real articles, only the POST is left out.
  const port = makeFakeDraftPort();
  const result = await publishDraft(request(), port);

  assert.equal(port.argsFor('uploadPhoto').length, 2);
  assert.equal(result.payload.item.catalog_id, 196);
  assert.equal(result.payload.item.status_id, 2);
  assert.equal(result.payload.item.price, 18);
  assert.ok(port.calls.some(c => c.name === 'log' && c.args[0] === 'publish_dry_run'));
});

test('the dry run writes nothing to the history', async () => {
  const port = makeFakeDraftPort();
  await publishDraft(request(), port);
  assert.equal(port.called('recordDraft'), false);
});

// ================================================================================
// The happy path.
// ================================================================================

test('a complete draft creates the listing and reports it', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  const result = await publishDraft(request(), port);

  assert.equal(result.newId, 555001);
  assert.equal(result.newUrl, 'https://www.vinted.de/items/555001');
  assert.equal(port.called('createItem'), true);
  assert.equal(port.called('recordDraft'), true);
});

test('every photo travels under the same upload session id', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  const result = await publishDraft(request(), port);

  const sessions = port.argsFor('uploadPhoto').map(a => a[4].tempUuid);
  assert.deepEqual(sessions, ['sess-fixed', 'sess-fixed']);
  assert.equal(result.newId, 555001);
});

test('the order is upload → suggestions → create, never the other way round', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  await publishDraft(request(), port);

  const names = port.names;
  assert.ok(names.indexOf('uploadPhoto') < names.indexOf('createItem'));
  assert.ok(names.indexOf('suggestCategories') < names.indexOf('createItem'));
});

// ================================================================================
// What the category demands — asked before the first upload.
// ================================================================================

test('a category that demands an attribute we cannot fill stops the draft', async () => {
  // The relist path met this from the other side on 2026-08-12: `language_book: Wähle eine
  // Sprache`, thrown by createItem, with every photo already uploaded.
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    categoryAttributes: () => [{ code: 'language_book', value_ids: [] }]
  });
  await assert.rejects(() => publishDraft(request(), port), /language_book/);
  assert.equal(port.called('uploadPhoto'), false, 'the whole point is that it costs no upload');
  assert.equal(port.called('createItem'), false);
});

test('the attributes are asked for the resolved category, and the answer is logged', async () => {
  const port = makeFakeDraftPort();
  await publishDraft(request(), port);
  assert.deepEqual(port.argsFor('categoryAttributes')[0][2], 196);
  const logged = port.calls.find(c => c.name === 'log' && c.args[0] === 'category_attributes');
  assert.deepEqual(logged.args[1], { catalogId: 196, codes: [] });
});

test('a failing attribute call does not block a reviewed draft', async () => {
  // Same rule as the cross-check: this is a safety net. If it falls out, what held before
  // still holds — createItem decides.
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    categoryAttributes: () => { throw new ApiError(500, 'boom'); }
  });
  const result = await publishDraft(request(), port);
  assert.equal(result.newId, 555001);
  assert.ok(port.calls.some(c => c.name === 'log' && c.args[0] === 'category_attributes_failed'));
});

// ================================================================================
// The parcel size — Vinted's own recommendation instead of null.
// ================================================================================

test('the parcel size comes from Vinted and lands in the payload', async () => {
  const port = makeFakeDraftPort();
  const result = await publishDraft(request(), port);
  assert.equal(result.payload.item.package_size_id, 2);

  const [domain, opts] = port.argsFor('suggestPackageSize')[0];
  assert.equal(domain, 'www.vinted.de');
  assert.equal(opts.catalogId, 196);
  assert.equal(opts.brandId, 53);
  assert.equal(opts.sizeId, 105);
  assert.equal(opts.uploadSessionId, 'sess-fixed', 'the call does not exist without one');
  assert.equal(opts.price, 18);
  assert.ok(opts.title.includes('Nike'), 'the suggestion reads the finished title');
});

test('the parcel size is asked only once the upload session exists', async () => {
  const port = makeFakeDraftPort();
  await publishDraft(request(), port);
  assert.ok(port.names.indexOf('uploadPhoto') < port.names.indexOf('suggestPackageSize'));
});

test('no recommendation, no parcel size — and never a guessed one', async () => {
  const port = makeFakeDraftPort({ suggestPackageSize: () => null });
  const result = await publishDraft(request(), port);
  assert.equal(result.payload.item.package_size_id, null);
  assert.ok(port.calls.some(c => c.name === 'log' && c.args[0] === 'package_size'));
});

test('a failing parcel-size call costs the recommendation, not the listing', async () => {
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    suggestPackageSize: () => { throw new ApiError(404, 'wrong host'); }
  });
  const result = await publishDraft(request(), port);
  assert.equal(result.newId, 555001);
  assert.ok(port.calls.some(c => c.name === 'log' && c.args[0] === 'package_size_failed'));
});

// ================================================================================
// The language check, before anything is uploaded.
// ================================================================================

test('German texts on vinted.fr stop before the first upload', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true, draftLanguage: 'de' } });
  await assert.rejects(() => publishDraft(request({ domain: 'www.vinted.fr' }), port), /Sprache|erwartet/);
  assert.equal(port.called('uploadPhoto'), false, 'a wrong-language listing must not cost an upload');
});

test('the matching domain passes', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true, draftLanguage: 'de' } });
  const result = await publishDraft(request({ domain: 'www.vinted.at' }), port);
  assert.equal(result.newId, 555001);
});

test('an unknown domain makes no claim about the language', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true, draftLanguage: 'de' } });
  const result = await publishDraft(request({ domain: 'www.example.org' }), port);
  assert.equal(result.newId, 555001);
});

// ================================================================================
// The cross-check with Vinted's own recognition (Entscheidung C).
// ================================================================================

test('Vinted agreeing changes nothing', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  const result = await publishDraft(request(), port);
  assert.equal(result.newId, 555001);
});

test('Vinted disagreeing stops the create — after the upload, deliberately', async () => {
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    suggestCategories: () => [1807] // we resolved 196
  });

  const result = await publishDraft(request(), port);
  assert.equal(result.conflict, true);
  assert.equal(port.called('uploadPhoto'), true, 'the photos had to be up to ask at all');
  assert.equal(port.called('createItem'), false, 'and that is the point');
});

test('a disagreement hands the two answers BACK, it does not throw them away', async () => {
  // The dead end this replaced: the conflict was a ValidationError, so Vinteds candidates
  // died with it. The studio showed "Vinted widerspricht", nothing became selectable, and
  // pressing publish again re-uploaded three photos into the same wall.
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    suggestCategories: () => [1807]
  });

  const result = await publishDraft(request(), port);
  assert.equal(result.resolved.catalog.agreed, false);
  assert.equal(result.resolved.catalog.id, null, 'the field is emptied, not quietly kept');
  assert.ok(result.resolved.catalog.candidates.length >= 2, 'ours and theirs, both on offer');
  assert.ok(result.blockers.length, 'and the studio is told what is open');
});

test('a conflict is reported as a decision to make, not as a failure', async () => {
  const message = describeDraftOutcome({ conflict: true, blockers: ['Farbe bestätigen'] });
  assert.equal(message.kind, 'warning', 'two recognisers disagreeing is the feature working');
  assert.match(message.text, /Farbe bestätigen/);
  assert.match(message.text, /neu hochgeladen/, 'the re-upload is a real cost and is named');
});

test('conflictedFields names the fields the studio has to reopen', () => {
  const resolved = {
    catalog: { id: 196, agreed: true },
    color: { id: null, agreed: false, candidates: [{ id: 9 }, { id: 10 }] },
    brand: { id: 53, agreed: true },
    size: { id: 105 }
  };
  assert.deepEqual(conflictedFields(resolved), ['color'], 'by FIELD key, not by resolution key');
  assert.deepEqual(conflictedFields({}), []);
  assert.deepEqual(conflictedFields(), []);
});

test('uploads without an image id say so instead of going quiet', async () => {
  // What a dry run looked like in 0.79.0: three `publish_photo` lines and then nothing at
  // all — the cross-check returned early because the upload answers carried no
  // `high_resolution.id`, and it returned SILENTLY. A log that stops mid-run reads like a
  // hang, and the next hour goes into looking for one.
  let photoId = 0;
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    uploadPhoto: () => ({ id: ++photoId, temp_uuid: 'u-1' }) // no high_resolution
  });

  const result = await publishDraft(request(), port);
  assert.equal(result.newId, 555001, 'a missing image id is not a reason to fail');
  assert.equal(port.called('suggestCategories'), false, 'there was nothing to ask about');
  const events = port.argsFor('log').map(a => a[0]);
  assert.ok(events.includes('publish_suggestions_skipped'), events.join(', '));
});

test('a failing suggestion endpoint does not block a reviewed draft', async () => {
  // Vinted's suggestions are a convenience. Losing them must not cost the user their work.
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    suggestCategories: () => { throw new ApiError(500, 'boom'); }
  });
  const result = await publishDraft(request(), port);
  assert.equal(result.newId, 555001);
  assert.ok(port.calls.some(c => c.name === 'log' && c.args[0] === 'publish_suggestions_failed'));
});

// ================================================================================
// Failure leaves nothing behind — there is no partial.
// ================================================================================

test('a failed create leaves no history entry', async () => {
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    createItem: () => { throw new ApiError(422, '{"message_code":"validation_error"}'); }
  });

  await assert.rejects(() => publishDraft(request(), port), ApiError);
  assert.equal(port.called('recordDraft'), false);
});

test('a create that returns no id is a failure, not a success with a hole', async () => {
  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true }, createItem: () => ({}) });
  await assert.rejects(() => publishDraft(request(), port), /kein Inserat/);
  assert.equal(port.called('recordDraft'), false);
});

test('a failed upload stops the run before anything is created', async () => {
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    uploadPhoto: () => { throw new ApiError(413, 'too large'); }
  });

  await assert.rejects(() => publishDraft(request(), port), ApiError);
  assert.equal(port.called('createItem'), false);
});

test('an incomplete session is refused before the upload', async () => {
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    ensureAuth: () => ({ csrf: null, anonId: null })
  });
  await assert.rejects(() => publishDraft(request(), port), /Sitzung/);
  assert.equal(port.called('uploadPhoto'), false);
});

// ================================================================================
// The lock — shared with relist (§4.5).
// ================================================================================

test('a second publish while one is running is refused, and touches nothing', async () => {
  // The gate exists before the run starts, so the test never depends on timer ordering.
  let openGate;
  const gate = new Promise(resolve => { openGate = resolve; });
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    uploadPhoto: async () => {
      await gate;
      return { id: 1, temp_uuid: 'sess-fixed', high_resolution: { id: 'x' } };
    }
  });

  const first = publishDraft(request(), port);
  // Spin until the first run has actually reached the writing part and taken the lock.
  while (!port.called('uploadPhoto')) await new Promise(r => setImmediate(r));

  const second = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  await assert.rejects(() => publishDraft(request(), second), BusyError);
  assert.equal(second.called('uploadPhoto'), false, 'a refused writer touches nothing');

  openGate();
  await first;
});

test('the lock is released again after a failure', async () => {
  const failing = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    uploadPhoto: () => { throw new ApiError(500, 'boom'); }
  });
  await assert.rejects(() => publishDraft(request(), failing), ApiError);

  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  const result = await publishDraft(request(), port);
  assert.equal(result.newId, 555001, 'a failed run must not wedge the lock');
});

test('the lock is taken only for the writing part — a blocked draft never holds it', async () => {
  const blocked = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  await assert.rejects(() => publishDraft(request({ draft: { ...READY_DRAFT, price: null } }), blocked));

  const port = makeFakeDraftPort({ settings: { draftCreateEnabled: true } });
  const result = await publishDraft(request(), port);
  assert.equal(result.newId, 555001);
});

// ================================================================================
// The payload
// ================================================================================

test('the payload carries the resolved ids, not the model\'s strings', async () => {
  const port = makeFakeDraftPort();
  const { payload } = await publishDraft(request(), port);

  assert.equal(payload.item.catalog_id, 196);
  assert.equal(payload.item.brand_id, 53);
  assert.equal(payload.item.size_id, 105);
  assert.equal(payload.item.color1_id, 1);
  assert.equal(payload.item.package_size_id, 2);
});

test('the uploaded photo ids go into assigned_photos with orientation 0', async () => {
  const port = makeFakeDraftPort();
  const { payload } = await publishDraft(request(), port);
  assert.deepEqual(payload.item.assigned_photos, [
    { id: 1001, orientation: 0 },
    { id: 1002, orientation: 0 }
  ]);
});

test('the title is the built one, not something the studio sent along', async () => {
  const port = makeFakeDraftPort();
  const { payload } = await publishDraft(request(), port);
  assert.equal(payload.item.title, 'Nike Hoodies & Sweaters M / 38 / 10 Schwarz');
});

// ================================================================================
// Port and lock edge cases
// ================================================================================

test('missingMembers: names what an incomplete adapter is missing', () => {
  assert.deepEqual(missingMembers(null), ['port is not an object']);
  assert.deepEqual(missingMembers('nope'), ['port is not an object']);

  const broken = { ...makeFakeDraftPort(), createItem: undefined };
  assert.ok(missingMembers(broken).some(p => p.startsWith('createItem: missing')));
});

test('missingMembers: a rest param reports arity 0 and is refused', () => {
  // This is the whole reason for the ADAPTER RULE — a rest param hides the signature.
  const sloppy = { ...makeFakeDraftPort(), uploadPhoto: (...args) => args };
  assert.ok(missingMembers(sloppy).some(p => /uploadPhoto: declares 0 params/.test(p)));
});

test('currentWriter: names the holder while a publish runs, and lets go afterwards', async () => {
  assert.equal(currentWriter(), null);
  const port = makeFakeDraftPort({
    settings: { draftCreateEnabled: true },
    createItem: () => {
      assert.equal(currentWriter(), 'publish', 'the refusal can say what is running');
      return { id: 555001 };
    }
  });
  await publishDraft(request(), port);
  assert.equal(currentWriter(), null);
});
