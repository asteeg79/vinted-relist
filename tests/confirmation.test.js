import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { hasConfirmedDelete, setConfirmedDelete, resetConfirmedDelete } from '../lib/confirmation.js';

beforeEach(() => installChromeMock());
afterEach(() => { delete globalThis.chrome; });

test('starts unconfirmed', async () => {
  assert.equal(await hasConfirmedDelete(), false);
});

test('setConfirmedDelete makes it stick', async () => {
  await setConfirmedDelete();
  assert.equal(await hasConfirmedDelete(), true);
});

test('setConfirmedDelete is idempotent', async () => {
  await setConfirmedDelete();
  await setConfirmedDelete();
  assert.equal(await hasConfirmedDelete(), true);
});

test('resetConfirmedDelete re-arms the first-run gate', async () => {
  await setConfirmedDelete();
  await resetConfirmedDelete();
  assert.equal(await hasConfirmedDelete(), false);
});

test('a falsy stored value counts as unconfirmed', async () => {
  installChromeMock({ confirmedDelete: false });
  assert.equal(await hasConfirmedDelete(), false);
});
