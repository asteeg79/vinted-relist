import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import {
  SECRET_KEY, SESSION_KEY,
  encryptKey, decryptKey, storeKey, unlockKey,
  cacheKey, readCachedKey, hasStoredKey, clearKey
} from '../lib/secret.js';

const API_KEY = 'sk-ant-api03-0123456789abcdef';
const PASSPHRASE = 'korrektes pferd batterie klammer';

beforeEach(() => installChromeMock());

// ---------- round trip ----------

test('encrypt → decrypt returns the original key', async () => {
  const record = await encryptKey(API_KEY, PASSPHRASE);
  assert.equal(await decryptKey(record, PASSPHRASE), API_KEY);
});

test('the record is base64 only — no plaintext anywhere in it', async () => {
  const record = await encryptKey(API_KEY, PASSPHRASE);
  assert.deepEqual(Object.keys(record).sort(), ['ciphertext', 'iv', 'salt']);
  const serialised = JSON.stringify(record);
  assert.ok(!serialised.includes(API_KEY));
  assert.ok(!serialised.includes('sk-ant'));
  assert.ok(!serialised.includes(PASSPHRASE));
});

test('two encryptions of the same key differ (fresh salt and iv)', async () => {
  const a = await encryptKey(API_KEY, PASSPHRASE);
  const b = await encryptKey(API_KEY, PASSPHRASE);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  // Both still decrypt.
  assert.equal(await decryptKey(a, PASSPHRASE), API_KEY);
  assert.equal(await decryptKey(b, PASSPHRASE), API_KEY);
});

test('unicode passphrases work', async () => {
  const record = await encryptKey(API_KEY, 'Grüße aus München 🔐');
  assert.equal(await decryptKey(record, 'Grüße aus München 🔐'), API_KEY);
});

// ---------- failure is loud ----------

test('a wrong passphrase throws instead of returning garbage', async () => {
  const record = await encryptKey(API_KEY, PASSPHRASE);
  await assert.rejects(() => decryptKey(record, 'falsch'), /Passphrase/);
});

test('a tampered ciphertext throws — AES-GCM authenticates', async () => {
  const record = await encryptKey(API_KEY, PASSPHRASE);
  const flipped = record.ciphertext.slice(0, -4) + (record.ciphertext.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  await assert.rejects(() => decryptKey({ ...record, ciphertext: flipped }, PASSPHRASE), /Passphrase/);
});

test('a malformed record throws rather than yielding a key', async () => {
  await assert.rejects(() => decryptKey(null, PASSPHRASE), /Kein/);
  await assert.rejects(() => decryptKey({ salt: 'x' }, PASSPHRASE), /Kein/);
});

test('no silent plaintext fallback: an empty passphrase is refused on both sides', async () => {
  await assert.rejects(() => encryptKey(API_KEY, ''), /Passphrase/);
  await assert.rejects(() => encryptKey(API_KEY, '   '), /Passphrase/);
  await assert.rejects(() => encryptKey(API_KEY, null), /Passphrase/);
  const record = await encryptKey(API_KEY, PASSPHRASE);
  await assert.rejects(() => decryptKey(record, ''), /Passphrase/);
});

test('an empty API key is refused — storing nothing would look like success', async () => {
  await assert.rejects(() => encryptKey('', PASSPHRASE), /Kein/);
  await assert.rejects(() => encryptKey('   ', PASSPHRASE), /Kein/);
});

// ---------- storage ----------

test('storeKey writes only the encrypted record to storage.local', async () => {
  const { store } = installChromeMock();
  await storeKey(API_KEY, PASSPHRASE);
  assert.ok(store[SECRET_KEY], 'no record stored');
  assert.ok(!JSON.stringify(store).includes(API_KEY), 'plaintext key reached storage.local');
  assert.equal(await hasStoredKey(), true);
});

test('storeKey does not put the key in the session cache — unlocking is explicit', async () => {
  await storeKey(API_KEY, PASSPHRASE);
  assert.equal(await readCachedKey(), API_KEY);
});

test('unlockKey decrypts the stored record and caches the plaintext in storage.session', async () => {
  const { store, sessionStore } = installChromeMock();
  await storeKey(API_KEY, PASSPHRASE);
  await chrome.storage.session.clear();

  assert.equal(await readCachedKey(), null);
  assert.equal(await unlockKey(PASSPHRASE), API_KEY);
  assert.equal(sessionStore[SESSION_KEY], API_KEY);
  assert.equal(await readCachedKey(), API_KEY);
  // The encrypted record is still the only thing in local storage.
  assert.ok(!JSON.stringify(store).includes(API_KEY));
});

test('unlockKey with the wrong passphrase throws and caches nothing', async () => {
  const { sessionStore } = installChromeMock();
  await storeKey(API_KEY, PASSPHRASE);
  await chrome.storage.session.clear();
  await assert.rejects(() => unlockKey('falsch'), /Passphrase/);
  assert.equal(sessionStore[SESSION_KEY], undefined);
});

test('unlockKey without a stored record throws', async () => {
  await assert.rejects(() => unlockKey(PASSPHRASE), /Kein/);
});

test('readCachedKey returns null when nothing is cached', async () => {
  assert.equal(await readCachedKey(), null);
  assert.equal(await hasStoredKey(), false);
});

test('cacheKey refuses to cache an empty value', async () => {
  await assert.rejects(() => cacheKey(''), /Kein/);
  assert.equal(await readCachedKey(), null);
});

test('clearKey removes both the record and the session cache', async () => {
  const { store, sessionStore } = installChromeMock();
  await storeKey(API_KEY, PASSPHRASE);
  await clearKey();
  assert.equal(store[SECRET_KEY], undefined);
  assert.equal(sessionStore[SESSION_KEY], undefined);
  assert.equal(await hasStoredKey(), false);
  assert.equal(await readCachedKey(), null);
});

test('a new browser session (session storage gone) still has the record, but no key', async () => {
  await storeKey(API_KEY, PASSPHRASE);
  await chrome.storage.session.clear(); // what the browser does on close
  assert.equal(await hasStoredKey(), true);
  assert.equal(await readCachedKey(), null);
  assert.equal(await unlockKey(PASSPHRASE), API_KEY);
});
