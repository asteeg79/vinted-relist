/**
 * Ein schreibender Vorgang — das gemeinsame Lock von Relist und Auto-Listing.
 *
 * The invariant in CONTEXT.md used to read "exactly one pipeline at a time". ADR-0007
 * sharpens it to "exactly one WRITING operation at a time", because the auto-listing's
 * preparation — cropping, recognition, taxonomy lookups — touches Vinted not at all or
 * only for reads, and blocking that behind a running relist would be pointless.
 *
 * So the lock starts at the first photo upload, and both pipelines take the same one.
 * Two concurrent writers would interleave their writes to the single `progress` record
 * and defeat the cooldown pacing that keeps Vinted's anti-bot heuristics quiet.
 */
import { BusyError } from './errors.js';

let inFlight = null;
let holder = null;

/** Who holds the lock right now, or null. Drives the "why is it busy" message. */
export function currentWriter() {
  return holder;
}

/**
 * Run `fn` under the write lock. Rejects with BusyError — without touching anything — if
 * another writer holds it.
 *
 * `name` names the holder so the refusal can say what is running instead of just "busy".
 */
export async function withWriteLock(name, fn) {
  if (inFlight) {
    throw new BusyError(BUSY_MESSAGES[holder] || BUSY_MESSAGES.default);
  }
  holder = name;
  inFlight = (async () => fn())();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
    holder = null;
  }
}

const BUSY_MESSAGES = {
  relist: 'Es läuft schon ein Relist. Warte, bis er fertig ist.',
  publish: 'Es wird gerade ein Inserat veröffentlicht. Warte, bis es fertig ist.',
  default: 'Es läuft schon ein schreibender Vorgang. Warte, bis er fertig ist.'
};

/** Test seam: drop the lock. Never call this from application code. */
export function resetWriteLock() {
  inFlight = null;
  holder = null;
}
