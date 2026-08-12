/**
 * Append-only diagnostic log, persisted in chrome.storage.local.
 *
 * Every pipeline step writes a structured line here. The popup renders the tail and the
 * "Log & Fehler kopieren" button copies it — this is the primary way the user reports
 * issues. Kept as a bounded ring buffer so it can never grow without limit.
 */
/** Exported so the popup reads and clears the same key this module writes. */
export const LOG_KEY = 'log';

const MAX_LINES = 500;

/**
 * Append one event line: `[ISO-timestamp] <event> <json-data>`.
 * Also mirrors to the console for live debugging in the SW devtools.
 */
export async function log(event, data = {}) {
  const line = `[${new Date().toISOString()}] ${event} ${JSON.stringify(data)}`;
  const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
  log.push(line);
  // Ring buffer: keep only the most recent MAX_LINES entries.
  if (log.length > MAX_LINES) log.splice(0, log.length - MAX_LINES);
  await chrome.storage.local.set({ [LOG_KEY]: log });
  try { console.log('[vinted-relist]', event, data); } catch {}
}

export async function clearLog() {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}
