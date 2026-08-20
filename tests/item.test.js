import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUrl, buildItemUploadPayload, buildNewItemPayload, extractInterest, pickPhotoUrl,
  photoOrientation, parseValidationErrors, conditionId, sizeId, fieldProbe
} from '../lib/item.js';
import { ValidationError } from '../lib/errors.js';

// ---------- parseUrl ----------
test('parseUrl: vinted.de item URL with slug', () => {
  const { domain, itemId } = parseUrl('https://www.vinted.de/items/1234567890-cool-jacket');
  assert.equal(domain, 'www.vinted.de');
  assert.equal(itemId, '1234567890');
});

test('parseUrl: vinted.fr without slug', () => {
  assert.equal(parseUrl('https://www.vinted.fr/items/42').itemId, '42');
});

test('parseUrl: vinted.co.uk multi-part TLD', () => {
  const { domain, itemId } = parseUrl('https://www.vinted.co.uk/items/999-hello');
  assert.equal(domain, 'www.vinted.co.uk');
  assert.equal(itemId, '999');
});

test('parseUrl: rejects non-vinted host', () => {
  assert.throws(() => parseUrl('https://www.ebay.com/items/123'), ValidationError);
});

test('parseUrl: rejects missing item id', () => {
  assert.throws(() => parseUrl('https://www.vinted.de/profile/foo'), ValidationError);
});

test('parseUrl: rejects garbage', () => {
  assert.throws(() => parseUrl('not a url'), ValidationError);
});

// ---------- buildItemUploadPayload ----------
const fullSrc = {
  id: 1, title: 'Esprit Hemd', description: 'schön', currency: 'EUR',
  brand_id: 17, brand: 'Esprit', catalog_id: 1803, status_id: 3, size_id: 207,
  package_size_id: 1, color1_id: 27, color2_id: null, is_unisex: 1,
  price: { amount: '4.0', currency_code: 'EUR' }
};

test('buildItemUploadPayload: maps fields and uses explicit session id', () => {
  const photos = [{ id: 100, temp_uuid: 'photo-uuid', orientation: 0 }];
  const p = buildItemUploadPayload(fullSrc, photos, 'session-xyz');
  assert.equal(p.item.title, 'Esprit Hemd');
  assert.equal(p.item.brand_id, 17);
  assert.equal(p.item.catalog_id, 1803);
  assert.equal(p.item.status_id, 3);
  assert.equal(p.item.price, 4);                 // parsed from {amount}
  assert.deepEqual(p.item.color_ids, [27]);      // null color2 filtered out
  assert.equal(p.item.temp_uuid, 'session-xyz');
  assert.equal(p.upload_session_id, 'session-xyz');
  assert.deepEqual(p.item.assigned_photos, [{ id: 100, orientation: 0 }]);
});

test('buildItemUploadPayload: preserves photo orientation', () => {
  const photos = [{ id: 1, orientation: 6 }, { id: 2, orientation: 0 }];
  const p = buildItemUploadPayload(fullSrc, photos, 's');
  assert.deepEqual(p.item.assigned_photos, [{ id: 1, orientation: 6 }, { id: 2, orientation: 0 }]);
});

test('buildItemUploadPayload: falls back to first photo temp_uuid as session id', () => {
  const p = buildItemUploadPayload(fullSrc, [{ id: 5, temp_uuid: 'tu' }]);
  assert.equal(p.upload_session_id, 'tu');
});

test('buildItemUploadPayload: numeric price string', () => {
  const p = buildItemUploadPayload({ ...fullSrc, price: '12.5' }, [{ id: 1 }], 's');
  assert.equal(p.item.price, 12.5);
});

test('buildItemUploadPayload: throws without any session id', () => {
  assert.throws(() => buildItemUploadPayload(fullSrc, [{ id: 1 }]), /session id is required/);
});

// ---------- extractInterest ----------
test('extractInterest: reads canonical field names', () => {
  const i = extractInterest({ favourite_count: 3, view_count: 50, conversation_count: 1 });
  assert.deepEqual(i, { favourites: 3, views: 50, conversations: 1 });
});

test('extractInterest: alternative field names', () => {
  const i = extractInterest({ total_users_favoured: 7, views_count: 12, messages_count: 2 });
  assert.deepEqual(i, { favourites: 7, views: 12, conversations: 2 });
});

test('extractInterest: defaults to zero', () => {
  assert.deepEqual(extractInterest({}), { favourites: 0, views: 0, conversations: 0 });
});

// ---------- pickPhotoUrl ----------
test('pickPhotoUrl: prefers full_size_url', () => {
  assert.equal(pickPhotoUrl({ full_size_url: 'a', url: 'b' }), 'a');
});

test('pickPhotoUrl: falls back through url → high_resolution → thumbnails', () => {
  assert.equal(pickPhotoUrl({ url: 'b' }), 'b');
  assert.equal(pickPhotoUrl({ high_resolution: { url: 'c' } }), 'c');
  assert.equal(pickPhotoUrl({ thumbnails: [{ url: 'x' }, { url: 'y' }] }), 'y');
  assert.equal(pickPhotoUrl({}), null);
});

// ---------- photoOrientation ----------
test('photoOrientation: reads high_resolution then top-level then 0', () => {
  assert.equal(photoOrientation({ high_resolution: { orientation: 6 } }), 6);
  assert.equal(photoOrientation({ orientation: 3 }), 3);
  assert.equal(photoOrientation({}), 0);
});

// ---------- parseValidationErrors ----------
test('parseValidationErrors: extracts field + value from a validation_error body', () => {
  const body = JSON.stringify({
    code: 99, message_code: 'validation_error',
    errors: [{ field: 'color', value: 'Wähle ein Farbe, um fortzufahren' }]
  });
  const errs = parseValidationErrors(body);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].field, 'color');
  assert.match(errs[0].value, /Farbe/);
});

test('parseValidationErrors: accepts an already-parsed object', () => {
  const errs = parseValidationErrors({ message_code: 'validation_error', errors: [{ field: 'size', value: 'x' }] });
  assert.equal(errs[0].field, 'size');
});

test('parseValidationErrors: null for non-validation / unparseable bodies', () => {
  assert.equal(parseValidationErrors('<html>403</html>'), null);
  assert.equal(parseValidationErrors(JSON.stringify({ code: 104, message_code: 'not_found' })), null);
  assert.equal(parseValidationErrors(JSON.stringify({ message_code: 'validation_error', errors: [] })), null);
  assert.equal(parseValidationErrors(undefined), null);
});

// ---------- conditionId / sizeId: Vinted renames these ----------
// Observed live: GET /api/v2/item_upload/items/{id} returned status_id + size_id until
// 2026-07-11, then stopped (2026-08-12), so the create call carried no condition and was
// rejected with `condition: Wähle ein Zustand`. Each known shape must be tried.

test('conditionId: reads the historical status_id', () => {
  assert.equal(conditionId({ status_id: 2 }), 2);
});

test('conditionId: falls back through the known aliases', () => {
  assert.equal(conditionId({ condition_id: 3 }), 3);
  assert.equal(conditionId({ status: { id: 4 } }), 4);
  assert.equal(conditionId({ condition: { id: 5 } }), 5);
});

test('conditionId: prefers status_id when several shapes are present', () => {
  assert.equal(conditionId({ status_id: 2, condition_id: 9, status: { id: 8 } }), 2);
});

test('conditionId: null when absent — never invents a condition', () => {
  // A guessed condition would misdescribe the goods to buyers, so the pipeline must fail
  // rather than default. This is deliberately NOT like the colour auto-recovery.
  assert.equal(conditionId({}), null);
  assert.equal(conditionId({ status_id: null }), null);
});

test('sizeId: reads size_id, then the nested shape, else null', () => {
  assert.equal(sizeId({ size_id: 620 }), 620);
  assert.equal(sizeId({ size: { id: 621 } }), 621);
  assert.equal(sizeId({}), null);
});

test('buildItemUploadPayload: carries condition and size through from an aliased source', () => {
  const src = { title: 'X', catalog_id: 1, price: 5, condition: { id: 3 }, size: { id: 620 } };
  const payload = buildItemUploadPayload(src, [{ id: 1, temp_uuid: 't' }], 'sess');
  assert.equal(payload.item.status_id, 3);
  assert.equal(payload.item.size_id, 620);
});

test('buildItemUploadPayload: an unreadable condition becomes explicit null, not a dropped key', () => {
  // JSON.stringify drops undefined, so an undefined status_id vanished from the request
  // body entirely — the failure mode seen live. null at least travels.
  const payload = buildItemUploadPayload({ title: 'X', catalog_id: 1, price: 5 }, [{ id: 1, temp_uuid: 't' }], 'sess');
  assert.equal(payload.item.status_id, null);
  assert.ok('status_id' in JSON.parse(JSON.stringify(payload)).item, 'status_id must survive serialisation');
});

// ---------- the shapes still open after the 2026-08-12 probe ----------

test('conditionId: a bare numeric status is read (status exists but is not {id})', () => {
  // The live response has a `status` key whose `.id` is undefined, so it is not an object.
  assert.equal(conditionId({ status: 2 }), 2);
});

test('conditionId: a nested status object still wins over the bare number path', () => {
  assert.equal(conditionId({ status: { id: 7 } }), 7);
});

test('conditionId: a non-numeric status is NOT guessed at', () => {
  // A label like "Gut" cannot be turned into an id without a mapping table, and inventing
  // one would misdescribe the item's condition to buyers.
  assert.equal(conditionId({ status: 'Gut' }), null);
});

test('sizeId: read out of the item_attributes bag by code', () => {
  // The live response has no size/size_id key at all — only item_attributes.
  assert.equal(sizeId({ item_attributes: [{ code: 'size', ids: [620] }] }), 620);
  assert.equal(sizeId({ item_attributes: [{ name: 'size', value_ids: [621] }] }), 621);
  assert.equal(sizeId({ item_attributes: [{ code: 'size', id: 622 }] }), 622);
});

test('sizeId: an item_attributes bag with no size entry stays null', () => {
  assert.equal(sizeId({ item_attributes: [{ code: 'material', ids: [3] }] }), null);
  assert.equal(sizeId({ item_attributes: [] }), null);
  assert.equal(sizeId({ item_attributes: 'not-an-array' }), null);
});

test('sizeId: an unrecognised attribute encoding stays null rather than guessing', () => {
  assert.equal(sizeId({ item_attributes: [{ code: 'size', label: 'M' }] }), null);
  assert.equal(sizeId({ item_attributes: [{ code: 'size', ids: [] }] }), null);
});

test('conditionId: also searches item_attributes', () => {
  assert.equal(conditionId({ item_attributes: [{ code: 'condition', ids: [3] }] }), 3);
});

// ---------- fieldProbe ----------

test('fieldProbe: collects the values of every candidate field', () => {
  const probe = fieldProbe({
    status: 2, size_id: null, item_attributes: [{ code: 'size' }],
    color1: { id: 15, title: 'Bunt' }, package_size_id: 1,
    title: 'ignored', description: 'ignored'
  });
  assert.deepEqual(Object.keys(probe).sort((a, b) => a.localeCompare(b)),
    ['color1', 'item_attributes', 'package_size_id', 'size_id', 'status']);
  assert.equal(probe.status, 2);
  assert.ok(!('title' in probe), 'unrelated fields are left out');
});

test('fieldProbe: includes color1 as the shape reference but not other colours', () => {
  const probe = fieldProbe({ color1: { id: 15 }, color2: { id: 3 }, color1_id: 15 });
  assert.ok('color1' in probe);
  assert.ok(!('color2' in probe));
});

test('fieldProbe: survives an empty or absent source', () => {
  assert.deepEqual(fieldProbe({}), {});
  assert.deepEqual(fieldProbe(), {});
});

// ---------- item_attributes must survive the relist ----------
// Observed live 2026-08-12: a comics listing was rejected with `language_book: Wähle eine
// Sprache`. The source carried its attributes in `item_attributes`, but the create payload
// never sent them back — so every per-category attribute was silently dropped.

test('buildItemUploadPayload: replays item_attributes verbatim', () => {
  const attributes = [
    { code: 'condition', ids: [2] },
    { code: 'language_book', ids: [7] }
  ];
  const payload = buildItemUploadPayload(
    { title: 'X', catalog_id: 5425, price: 10, item_attributes: attributes },
    [{ id: 1, temp_uuid: 't' }], 'sess'
  );
  assert.deepEqual(payload.item.item_attributes, attributes);
});

test('buildItemUploadPayload: a source with no attributes sends an empty bag, not undefined', () => {
  const payload = buildItemUploadPayload({ title: 'X', catalog_id: 1, price: 5 }, [{ id: 1, temp_uuid: 't' }], 'sess');
  assert.deepEqual(payload.item.item_attributes, []);
  assert.ok('item_attributes' in JSON.parse(JSON.stringify(payload)).item, 'must survive serialisation');
});

test('buildItemUploadPayload: a malformed attribute bag degrades to empty', () => {
  for (const bad of ['nope', 42, { code: 'x' }, null]) {
    const payload = buildItemUploadPayload(
      { title: 'X', catalog_id: 1, price: 5, item_attributes: bad }, [{ id: 1, temp_uuid: 't' }], 'sess');
    assert.deepEqual(payload.item.item_attributes, []);
  }
});

test('buildItemUploadPayload: condition is sent both as status_id and inside the bag', () => {
  // Belt and braces — the bag is the user's data, status_id is what the endpoint reads.
  const attributes = [{ code: 'condition', ids: [2] }];
  const payload = buildItemUploadPayload(
    { title: 'X', catalog_id: 1, price: 5, item_attributes: attributes },
    [{ id: 1, temp_uuid: 't' }], 'sess'
  );
  assert.equal(payload.item.status_id, 2);
  assert.deepEqual(payload.item.item_attributes, attributes);
});

// ---------- category-specific fields must survive the relist too ----------
// The 2026-08-12 key set showed the source carries author/book_title/model/ontology ids
// and measurement_unit, none of which the payload sent back — so a relisted comic lost its
// author and title, and the measurements travelled without their unit.

test('buildItemUploadPayload: replays book fields', () => {
  const payload = buildItemUploadPayload(
    { title: 'X', catalog_id: 5425, price: 10, author: 'Stan Lee', book_title: 'X-Men #1' },
    [{ id: 1, temp_uuid: 't' }], 'sess'
  );
  assert.equal(payload.item.author, 'Stan Lee');
  assert.equal(payload.item.book_title, 'X-Men #1');
});

test('buildItemUploadPayload: measurements keep their unit', () => {
  const payload = buildItemUploadPayload(
    { title: 'X', catalog_id: 1, price: 5, measurement_length: 70, measurement_width: 50, measurement_unit: 'cm' },
    [{ id: 1, temp_uuid: 't' }], 'sess'
  );
  assert.equal(payload.item.measurement_length, 70);
  assert.equal(payload.item.measurement_unit, 'cm');
});

test('buildItemUploadPayload: replays model and ontology ids', () => {
  const payload = buildItemUploadPayload(
    { title: 'X', catalog_id: 1, price: 5, model: 'Air Max', ontology_collection_id: 11, ontology_model_id: 22, video_game_rating_id: 3 },
    [{ id: 1, temp_uuid: 't' }], 'sess'
  );
  assert.equal(payload.item.model, 'Air Max');
  assert.equal(payload.item.ontology_collection_id, 11);
  assert.equal(payload.item.ontology_model_id, 22);
  assert.equal(payload.item.video_game_rating_id, 3);
});

test('buildItemUploadPayload: absent category fields go as null, like isbn already does', () => {
  const payload = buildItemUploadPayload({ title: 'X', catalog_id: 1, price: 5 }, [{ id: 1, temp_uuid: 't' }], 'sess');
  for (const key of ['author', 'book_title', 'model', 'measurement_unit', 'ontology_collection_id', 'ontology_model_id', 'video_game_rating_id']) {
    assert.equal(payload.item[key], null, `${key} must be explicit null, not undefined`);
    assert.ok(key in JSON.parse(JSON.stringify(payload)).item, `${key} must survive serialisation`);
  }
});

// ---------- buildNewItemPayload ----------

/** Everything a resolved draft carries by the time publishing is released. */
const fullDraft = {
  title: 'Nike Hoodie M Schwarz',
  description: 'Ein schlichter Hoodie.',
  catalogId: 196,
  brandId: 53,
  brand: 'Nike',
  sizeId: 105,
  statusId: 2,
  colorIds: [1, 27],
  packageSizeId: 2,
  price: 18,
  currency: 'EUR'
};
const NEW_PHOTOS = [
  { id: 111, temp_uuid: 'sess-1', orientation: 6 },
  { id: 222, temp_uuid: 'sess-1', orientation: 3 }
];

test('buildNewItemPayload: carries every field Vinted needs for a create', () => {
  const p = buildNewItemPayload(fullDraft, NEW_PHOTOS, 'sess-1');
  assert.equal(p.item.title, 'Nike Hoodie M Schwarz');
  assert.equal(p.item.catalog_id, 196);
  assert.equal(p.item.brand_id, 53);
  assert.equal(p.item.size_id, 105);
  assert.equal(p.item.status_id, 2);
  assert.equal(p.item.price, 18);
  assert.equal(p.item.package_size_id, 2);
  assert.deepEqual(p.item.color_ids, [1, 27]);
  assert.equal(p.item.color1_id, 1);
  assert.equal(p.item.color2_id, 27);
  assert.equal(p.item.currency, 'EUR');
});

test('buildNewItemPayload: temp_uuid and upload_session_id are the same value', () => {
  const p = buildNewItemPayload(fullDraft, NEW_PHOTOS, 'sess-1');
  assert.equal(p.item.temp_uuid, 'sess-1');
  assert.equal(p.upload_session_id, 'sess-1');
});

test('buildNewItemPayload: orientation is ALWAYS 0 — the canvas already uprighted the pixels', () => {
  // The photos above carry EXIF orientations 6 and 3. Passing them through would rotate
  // an already-rotated image a second time (KONZEPT §5.5).
  const p = buildNewItemPayload(fullDraft, NEW_PHOTOS, 'sess-1');
  assert.deepEqual(p.item.assigned_photos, [{ id: 111, orientation: 0 }, { id: 222, orientation: 0 }]);
});

test('buildNewItemPayload: ai_photo is false, as on the relist path', () => {
  assert.equal(buildNewItemPayload(fullDraft, NEW_PHOTOS, 'sess-1').item.ai_photo, false);
});

test('buildNewItemPayload: falls back to the first photo\'s temp_uuid', () => {
  const p = buildNewItemPayload(fullDraft, NEW_PHOTOS);
  assert.equal(p.upload_session_id, 'sess-1');
});

test('buildNewItemPayload: a missing mandatory field throws — it never travels as undefined', () => {
  for (const field of ['title', 'catalogId', 'statusId', 'price']) {
    const draft = { ...fullDraft, [field]: undefined };
    assert.throws(() => buildNewItemPayload(draft, NEW_PHOTOS, 'sess-1'), ValidationError, field);
  }
});

test('buildNewItemPayload: a condition of null throws rather than being invented', () => {
  // ADR-0005: the condition is shown to buyers and is legally binding.
  assert.throws(() => buildNewItemPayload({ ...fullDraft, statusId: null }, NEW_PHOTOS, 'sess-1'), /status_id/);
});

test('buildNewItemPayload: a price of zero or nonsense is not a price', () => {
  for (const price of [0, -5, 'teuer', null]) {
    assert.throws(() => buildNewItemPayload({ ...fullDraft, price }, NEW_PHOTOS, 'sess-1'), /price/);
  }
});

test('buildNewItemPayload: a numeric price string is accepted', () => {
  assert.equal(buildNewItemPayload({ ...fullDraft, price: '18.5' }, NEW_PHOTOS, 'sess-1').item.price, 18.5);
});

test('buildNewItemPayload: no photos, no listing', () => {
  assert.throws(() => buildNewItemPayload(fullDraft, [], 'sess-1'), /Foto/);
  assert.throws(() => buildNewItemPayload(fullDraft, []), ValidationError);
});

test('buildNewItemPayload: optional ids go as null, never as undefined', () => {
  const sparse = { ...fullDraft, brandId: undefined, brand: undefined, sizeId: undefined, packageSizeId: undefined, colorIds: undefined };
  const p = buildNewItemPayload(sparse, NEW_PHOTOS, 'sess-1');
  for (const key of ['brand_id', 'brand', 'size_id', 'package_size_id', 'color1_id', 'color2_id']) {
    assert.equal(p.item[key], null, key);
  }
  assert.deepEqual(p.item.color_ids, []);
  assert.ok(!JSON.stringify(p).includes('undefined'));
});

test('buildNewItemPayload: no source item means no replayed media fields', () => {
  const p = buildNewItemPayload(fullDraft, NEW_PHOTOS, 'sess-1');
  assert.equal(p.item.measurement_length, null);
  assert.equal(p.item.measurement_unit, null);
  assert.equal(p.item.isbn, null);
  assert.deepEqual(p.item.item_attributes, []);
});

test('buildNewItemPayload: the envelope matches the relist create exactly', () => {
  const p = buildNewItemPayload(fullDraft, NEW_PHOTOS, 'sess-1');
  assert.equal(p.feedback_id, null);
  assert.equal(p.push_up, false);
  assert.equal(p.parcel, null);
  assert.deepEqual(p.item.shipment_prices, { domestic: null, international: null });
});

test('buildNewItemPayload: it is a SECOND builder — the relist one is untouched', () => {
  // ADR-0004: a change to reading must not be able to break creating.
  const relist = buildItemUploadPayload(fullSrc, [{ id: 9, temp_uuid: 'u', orientation: 6 }], 'u');
  assert.equal(relist.item.assigned_photos[0].orientation, 6, 'the relist path still replays EXIF');
});
