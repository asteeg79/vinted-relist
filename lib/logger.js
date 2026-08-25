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
 *
 * WIRFT NIE. Das Protokollieren ist die Beigabe, nie der Zweck — und es steht an über
 * dreißig Stellen, mehrere davon in `catch`-Blöcken, deren einzige Aufgabe es ist, Vinteds
 * feldweise Auskunft zu retten („isbn: Bitte gib eine ISBN an"). Ein `await` auf eine
 * abgelehnte Log-Zeile wirft dort AUS DEM catch heraus, und was beim Nutzer ankommt, ist
 * ein Speicherfehler statt der Auskunft, um die es ging. Zwei Dinge können hier schiefgehen
 * — der Speicher (Kontingent voll, Worker im Abbau) und `JSON.stringify` an einem
 * zyklischen `data`.
 *
 * Der Preis ist ausgesprochen: ein kaputtes Log schweigt, statt sich zu melden. Das ist der
 * richtige Handel — ein Log, das den Lauf abbricht, den es beschreiben soll, ist schlimmer
 * als eine fehlende Zeile. Die Konsole bekommt sie trotzdem, dort ist sie live zu sehen.
 */
export async function log(event, data = {}) {
  try { console.log('[vinted-relist]', event, data); } catch {}
  try {
    const line = `[${new Date().toISOString()}] ${event} ${JSON.stringify(data)}`;
    const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
    log.push(line);
    // Ring buffer: keep only the most recent MAX_LINES entries.
    if (log.length > MAX_LINES) log.splice(0, log.length - MAX_LINES);
    await chrome.storage.local.set({ [LOG_KEY]: log });
  } catch {}
}

export async function clearLog() {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}
