/**
 * The Anthropic API key at rest — PBKDF2 + AES-GCM, WebCrypto only.
 *
 * WHY A STORED KEY AT ALL. The project principle used to read "no backend, no stored
 * credentials". ADR-0007 sharpens it to "no stored VINTED credentials, no backend in the
 * Vinted path": a third-party key of one's own is a different category — losing it costs
 * money, not the account.
 *
 * WHAT THIS PROTECTS AGAINST: later access to the profile directory or a backup. What it
 * does NOT protect against: someone sitting at the unlocked machine — they open the
 * studio and use the key through the user. The stronger lever is a project-specific key
 * with a hard spending limit in the Anthropic account: encryption lowers the probability,
 * the limit caps the damage.
 *
 * EXPLICITLY REJECTED (ADR-0007, "Do not re-suggest"): encrypting with a key that sits in
 * the extension code. Whoever reaches the storage reaches the code too — it costs an
 * attacker a minute and buys a false sense of safety.
 *
 * No dependency, no build step: crypto.subtle is global in the browser AND under Node, so
 * this module is regularly unit-testable.
 */
import { arrayBufferToBase64, base64ToBytes } from './util.js';

/** storage.local — the encrypted record, never the key. */
export const SECRET_KEY = 'anthropicKey';
/** storage.session — the decrypted key, wiped when the browser closes. */
export const SESSION_KEY = 'anthropicKeyPlain';

const PBKDF2_ITERATIONS = 250_000; // ~0.2 s on a laptop: unnoticeable once per session,
                                   // expensive in bulk for anyone brute-forcing a backup
const SALT_BYTES = 16;
const IV_BYTES = 12;                // AES-GCM standard nonce length

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const trimmed = value => (typeof value === 'string' ? value.trim() : '');

/** Derive the AES key from the passphrase. Never cached — deriving is the slow part on purpose. */
async function deriveKey(passphrase, salt, usage) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

/**
 * Encrypt a key with a passphrase → `{ salt, iv, ciphertext }`, all base64.
 *
 * Both arguments are required. An empty passphrase is refused rather than falling back to
 * storing plaintext: a silent fallback would leave the user believing the key is
 * protected when it is not.
 */
export async function encryptKey(plaintext, passphrase) {
  const key = trimmed(plaintext);
  if (!key) throw new Error('Kein API-Key angegeben.');
  if (!trimmed(passphrase)) throw new Error('Passphrase fehlt — ohne sie wird nichts gespeichert.');

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aes = await deriveKey(passphrase, salt, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, encoder.encode(key));

  return {
    salt: arrayBufferToBase64(salt),
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(ciphertext)
  };
}

/**
 * Decrypt a record. Throws on a wrong passphrase or a tampered record — AES-GCM
 * authenticates, so this can never return plausible-looking garbage.
 */
export async function decryptKey(record, passphrase) {
  if (!record?.salt || !record?.iv || !record?.ciphertext) throw new Error('Kein gespeicherter API-Key.');
  if (!trimmed(passphrase)) throw new Error('Passphrase fehlt.');

  const aes = await deriveKey(passphrase, base64ToBytes(record.salt), 'decrypt');
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
      aes,
      base64ToBytes(record.ciphertext)
    );
  } catch {
    // WebCrypto reports a failed tag check and a wrong key identically, and so do we.
    throw new Error('Falsche Passphrase oder beschädigter Eintrag.');
  }
  return decoder.decode(plain);
}

/** Encrypt and persist; the key is cached for this browser session as a side effect. */
export async function storeKey(plaintext, passphrase) {
  const record = await encryptKey(plaintext, passphrase);
  await chrome.storage.local.set({ [SECRET_KEY]: record });
  await cacheKey(trimmed(plaintext));
  return record;
}

/**
 * Unlock the stored key for this browser session: decrypt, cache, return. Called once per
 * session; every later call reads the cache via readCachedKey().
 */
export async function unlockKey(passphrase) {
  const { [SECRET_KEY]: record } = await chrome.storage.local.get(SECRET_KEY);
  const plaintext = await decryptKey(record, passphrase);
  await cacheKey(plaintext);
  return plaintext;
}

/**
 * Put the plaintext key in storage.session — cleared when the browser closes and, unlike
 * storage.local, not readable from content scripts by default.
 */
export async function cacheKey(plaintext) {
  const key = trimmed(plaintext);
  if (!key) throw new Error('Kein API-Key zum Zwischenspeichern.');
  await chrome.storage.session.set({ [SESSION_KEY]: key });
}

/** The key for this session, or null when the user has not unlocked it yet. */
export async function readCachedKey() {
  const { [SESSION_KEY]: key } = await chrome.storage.session.get(SESSION_KEY);
  return key || null;
}

/** Is there anything to unlock? Drives the settings UI ("set up" vs "unlock"). */
export async function hasStoredKey() {
  const { [SECRET_KEY]: record } = await chrome.storage.local.get(SECRET_KEY);
  return !!record?.ciphertext;
}

/** Forget the key entirely — record and session cache. */
export async function clearKey() {
  await chrome.storage.local.remove(SECRET_KEY);
  await chrome.storage.session.remove(SESSION_KEY);
}

/**
 * Was die Oberfläche für den Schlüssel anzeigen und anbieten soll.
 *
 * WARUM DAS EINE ENTSCHEIDUNG IST UND KEINE DARSTELLUNG. Bisher standen zwei Passwortfelder
 * und zwei Knöpfe („Speichern", „Entsperren") immer gleichzeitig da, in jedem Zustand. Wer
 * gerade erst einen Key einträgt, sieht „Entsperren" — was nichts tut. Wer nach dem
 * Browserstart nur entsperren will, sieht ein leeres Key-Feld und muss raten, ob er es
 * ausfüllen muss (nein). Drei Lagen, ein sichtbarer Weg pro Lage:
 *
 *   empty     nichts hinterlegt   → Key + Passphrase eingeben, ein Knopf
 *   locked    hinterlegt, gesperrt → nur die Passphrase, ein Knopf
 *   unlocked  einsatzbereit        → gar kein Feld, nur der Befund
 *
 * `title` ist die Überschrift, `hint` erklärt die Lage, `action` beschriftet den einen
 * Knopf (null, wenn es nichts zu tun gibt).
 */
export function describeKeyState({ stored = false, unlocked = false } = {}) {
  if (unlocked) {
    return {
      state: 'unlocked',
      kind: 'ok',
      title: 'KI ist einsatzbereit',
      hint: 'Der Schlüssel ist für diese Browser-Sitzung entsperrt. Nach dem Schließen des Browsers wird die Passphrase wieder gebraucht.',
      action: null,
      needsKey: false,
      needsPassphrase: false
    };
  }
  if (stored) {
    return {
      state: 'locked',
      kind: 'warn',
      title: 'KI ist gesperrt',
      hint: 'Der Schlüssel liegt verschlüsselt hier. Passphrase eingeben, dann erkennt das Studio wieder Fotos.',
      action: 'Entsperren',
      needsKey: false,
      needsPassphrase: true
    };
  }
  return {
    state: 'empty',
    kind: '',
    title: 'KI einrichten',
    hint: 'Ohne Anthropic-Schlüssel erkennt das Studio keine Fotos. Die Passphrase vergibst du selbst — sie verschlüsselt den Schlüssel auf diesem Rechner und wird einmal pro Browser-Sitzung gebraucht.',
    action: 'Schlüssel speichern & entsperren',
    needsKey: true,
    needsPassphrase: true
  };
}
