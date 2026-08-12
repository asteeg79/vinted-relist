import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PORT_MEMBERS, SYNC_MEMBERS, missingMembers } from '../lib/relist-port.js';
import { livePort } from '../lib/live-port.js';
import { makeFakePort } from './helpers/fake-port.js';

/**
 * Conformance: the live adapter is pure wiring, so the failure mode worth catching is it
 * drifting out of step with the interface (and therefore with the fake the safety tests
 * run on). These tests are what secures lib/live-port.js.
 */

test('livePort satisfies the RelistPort interface', () => {
  assert.deepEqual(missingMembers(livePort), []);
});

test('fake port satisfies the RelistPort interface', () => {
  assert.deepEqual(missingMembers(makeFakePort()), []);
});

test('both adapters expose exactly the declared members — no extras on the live one', () => {
  const declared = Object.keys(PORT_MEMBERS).sort();
  assert.deepEqual(Object.keys(livePort).sort(), declared);
});

test('the synchronous members stay synchronous in both adapters', () => {
  // relist.js uses these results directly, without awaiting — an adapter that made one
  // async would silently put a Promise into the upload session id.
  for (const port of [livePort, makeFakePort()]) {
    for (const name of SYNC_MEMBERS) {
      assert.equal(port[name].constructor.name, 'Function', `${name} must not be async`);
    }
  }
  assert.equal(typeof makeFakePort().newUploadSessionId(), 'string');
});

test('every member not listed as synchronous returns a promise', () => {
  const port = makeFakePort();
  for (const name of Object.keys(PORT_MEMBERS)) {
    if (SYNC_MEMBERS.includes(name)) continue;
    assert.equal(port[name].constructor.name, 'AsyncFunction', `${name} should be async`);
  }
});

test('missingMembers reports a missing member', () => {
  const port = makeFakePort();
  delete port.deleteItem;
  assert.deepEqual(missingMembers(port), ['deleteItem: missing (expected a function, got undefined)']);
});

test('missingMembers reports an arity mismatch', () => {
  const port = makeFakePort();
  port.fetchItem = (domain) => domain; // interface says 3
  assert.match(missingMembers(port)[0], /^fetchItem: declares 1 params, interface says 3/);
});

test('missingMembers rejects a non-object', () => {
  assert.deepEqual(missingMembers(null), ['port is not an object']);
  assert.deepEqual(missingMembers('nope'), ['port is not an object']);
});

/**
 * The fake is a test fixture, so it gets its own tests — a fake that silently lies would
 * make every safety assertion below it worthless.
 */

test('fake port records calls in order with their arguments', async () => {
  const port = makeFakePort();
  await port.ensureAuth('www.vinted.de', '111');
  await port.deleteItem('www.vinted.de', { csrf: 'c' }, '111');
  assert.deepEqual(port.names, ['ensureAuth', 'deleteItem']);
  assert.deepEqual(port.argsOf('deleteItem'), ['www.vinted.de', { csrf: 'c' }, '111']);
  assert.equal(port.countOf('deleteItem'), 1);
  assert.deepEqual(port.deleted, ['111']);
});

test('fake port: an override replaces behaviour but the call is still recorded', async () => {
  const port = makeFakePort({ fetchItem: () => { throw new Error('boom'); } });
  await assert.rejects(() => port.fetchItem('d', {}, '1'), /boom/);
  assert.equal(port.countOf('fetchItem'), 1);
});

test('fake port: createItem makes the new item fetchable, like the real API', async () => {
  const port = makeFakePort();
  await port.createItem('d', {}, { item: { title: 'X', assigned_photos: [{ id: 5, orientation: 1 }] } }, {});
  const verified = await port.fetchItem('d', {}, 999);
  assert.equal(verified.id, 999);
  assert.deepEqual(verified.photos, [{ id: 5, orientation: 1 }]);
});

test('fake port: settings merge over DEFAULT_SETTINGS', async () => {
  const port = makeFakePort({ settings: { deleteEnabled: false } });
  const s = await port.getSettings();
  assert.equal(s.deleteEnabled, false);
  assert.equal(s.photoQuality, 0.92, 'untouched defaults survive');
});
