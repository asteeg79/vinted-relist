/**
 * Relist history — a capped, newest-first log of every relist the user has run.
 *
 * Powers two UI features: the "Verlauf" list in the popup, and the cooldown counters
 * (relists in the last hour / 24h) that drive the soft anti-bot warning. Stored as a
 * plain array in chrome.storage.local.
 */
export const HISTORY_KEY = 'relistHistory';
const MAX_ENTRIES = 100; // hard cap so storage can't grow unbounded

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** All entries, newest first. */
export async function getHistory() {
  const { [HISTORY_KEY]: entries = [] } = await chrome.storage.local.get(HISTORY_KEY);
  return entries;
}

/**
 * Prepend an entry (stamped with the current time) and trim to MAX_ENTRIES.
 * `entry` carries { oldId, newId, title, domain, testMode }.
 */
export async function addEntry(entry) {
  const entries = await getHistory();
  entries.unshift({ ts: Date.now(), ...entry });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES; // drop oldest
  await chrome.storage.local.set({ [HISTORY_KEY]: entries });
  return entries;
}

export async function clearHistory() {
  await chrome.storage.local.remove(HISTORY_KEY);
}

/**
 * Rolling-window counts for a list of entries. Pure, so a caller that already holds the
 * history (the popup, rendering the list and the counters together) can tally it without
 * a second storage read.
 */
export function countWindows(entries = []) {
  const now = Date.now();
  let lastHour = 0, last24h = 0;
  for (const e of entries) {
    const age = now - (e.ts || 0);
    if (age <= HOUR_MS) lastHour++;
    if (age <= DAY_MS) last24h++;
  }
  return { lastHour, last24h, total: entries.length };
}

/** Rolling-window counts used by the cooldown warning. */
export async function getCounts() {
  return countWindows(await getHistory());
}
