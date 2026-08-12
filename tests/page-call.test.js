import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../content/page-call.js'; // classic script: loaded for its globalThis side effect
import { arrayBufferToBase64 } from '../lib/util.js';

/**
 * The `api/call` seam, tested from both sides.
 *
 * lib/util.js encodes, content/page-call.js decodes. Until these existed as one named
 * module the round trip could only be verified by relisting a real item and watching for
 * a 400 from Vinted.
 */
const { buildInit } = globalThis.VintedPageCall;

/** Rebuild the multipart parts exactly as lib/page-api.js does for a photo upload. */
async function photoUploadMessage(bytes, { tempUuid = 'sess-1' } = {}) {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const buffer = await blob.arrayBuffer();
  return {
    method: 'POST',
    path: '/api/v2/photos',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-1' },
    multipart: [
      { name: 'photo[temp_uuid]', kind: 'text', value: tempUuid },
      { name: 'photo[type]', kind: 'text', value: 'item' },
      {
        name: 'photo[file]', kind: 'blob_b64',
        data: arrayBufferToBase64(buffer),
        contentType: 'image/jpeg', filename: 'photo_0.jpg',
        expectedSize: buffer.byteLength
      }
    ]
  };
}

// ====================================================================================
// The round trip
// ====================================================================================

test('a photo survives encode → message → decode byte for byte', async () => {
  const original = new Uint8Array(Array.from({ length: 5000 }, (_, i) => i % 256));
  const { init, warnings } = buildInit(await photoUploadMessage(original));

  const file = init.body.get('photo[file]');
  const rebuilt = new Uint8Array(await file.arrayBuffer());
  assert.deepEqual([...rebuilt], [...original], 'bytes must be identical after the round trip');
  assert.equal(file.type, 'image/jpeg');
  assert.equal(file.name, 'photo_0.jpg');
  assert.deepEqual(warnings, []);
});

test('bytes spanning the base64 chunk boundary survive', async () => {
  // util.js encodes in 32KB chunks; a payload larger than one chunk is the interesting case.
  const original = new Uint8Array(0x8000 * 2 + 17).fill(0xAB);
  original[0x8000] = 0x01;
  original[0x8000 * 2] = 0x02;
  const { init } = buildInit(await photoUploadMessage(original));
  const rebuilt = new Uint8Array(await init.body.get('photo[file]').arrayBuffer());
  assert.equal(rebuilt.length, original.length);
  assert.deepEqual([...rebuilt], [...original]);
});

test('an empty payload round-trips without error', async () => {
  const { init, warnings } = buildInit(await photoUploadMessage(new Uint8Array(0)));
  assert.equal(init.body.get('photo[file]').size, 0);
  assert.deepEqual(warnings, []);
});

// ====================================================================================
// Multipart assembly
// ====================================================================================

test('text parts are carried across in order, alongside the file', async () => {
  const { init } = buildInit(await photoUploadMessage(new Uint8Array([1, 2, 3])));
  assert.deepEqual([...init.body.keys()], ['photo[temp_uuid]', 'photo[type]', 'photo[file]']);
  assert.equal(init.body.get('photo[temp_uuid]'), 'sess-1');
  assert.equal(init.body.get('photo[type]'), 'item');
});

test('Content-Type is stripped for multipart so the browser can set the boundary', async () => {
  const { init } = buildInit(await photoUploadMessage(new Uint8Array([1])));
  assert.equal(init.headers['Content-Type'], undefined);
  assert.equal(init.headers['X-CSRF-Token'], 'csrf-1', 'other headers are untouched');
});

test('buildInit does not mutate the caller\'s headers object', async () => {
  const msg = await photoUploadMessage(new Uint8Array([1]));
  buildInit(msg);
  assert.equal(msg.headers['Content-Type'], 'application/json', 'the message must be reusable');
});

test('raw-bytes parts are wrapped without base64', () => {
  const { init } = buildInit({
    method: 'POST', path: '/x',
    multipart: [{ name: 'f', kind: 'blob', data: new Uint8Array([9, 9]), contentType: 'text/plain', filename: 'f.txt' }]
  });
  assert.equal(init.body.get('f').size, 2);
});

// ====================================================================================
// Corruption is reported, not swallowed
// ====================================================================================

test('a decoded size that disagrees with expectedSize is reported as a warning', () => {
  const { init, warnings } = buildInit({
    method: 'POST', path: '/x',
    multipart: [{
      name: 'photo[file]', kind: 'blob_b64', data: arrayBufferToBase64(new Uint8Array([1, 2, 3]).buffer),
      contentType: 'image/jpeg', filename: 'p.jpg', expectedSize: 999
    }]
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /photo\[file\]: 3 bytes after decode, expected 999/);
  assert.ok(init.body.get('photo[file]'), 'the part is still assembled — the SW decides what to do');
});

// ====================================================================================
// JSON and plain requests
// ====================================================================================

test('a JSON request serialises the body and keeps its Content-Type', () => {
  const { init } = buildInit({
    method: 'POST', path: '/api/v2/item_upload/items',
    headers: { 'Content-Type': 'application/json' },
    json: { item: { title: 'X' } }
  });
  assert.equal(init.body, '{"item":{"title":"X"}}');
  assert.equal(init.headers['Content-Type'], 'application/json');
});

test('a GET carries no body and always sends cookies', () => {
  const { init } = buildInit({ method: 'GET', path: '/api/v2/item_upload/items/1', headers: {} });
  assert.equal(init.body, undefined);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'include');
});

test('a message with no method defaults to GET', () => {
  assert.equal(buildInit({ path: '/x' }).init.method, 'GET');
});
