/**
 * Progress reporting for the relist pipeline.
 *
 * The pipeline runs in the service worker, but the UI lives in two other contexts
 * (the popup and the on-page toast). Rather than message each one directly, the SW
 * writes the current {pct, step} to chrome.storage.local; both UIs subscribe via
 * chrome.storage.onChanged and re-render. This decouples producer from consumers and
 * survives the popup being closed/reopened mid-run (it reads the last value on open).
 */
/** Exported so subscribers (the popup) watch the same key this module writes. */
export const PROGRESS_KEY = 'progress';

/**
 * Publish a progress update. `pct` is rounded; `step` is a short human label.
 *
 * `steps` ist die Phasenliste aus `lib/steps.js` — was erledigt ist und was noch kommt.
 * Sie reist im Datensatz mit, weil eine der beiden Oberflächen sie sich nicht selbst
 * ausrechnen kann: das Content-Skript ist als Manifest-Skript geladen und darf keine
 * Module importieren. Also entscheidet der Adapter (der als einziger weiß, welche Pipeline
 * läuft), und beide Oberflächen zeichnen nur noch.
 */
export async function setProgress(pct, step, steps = []) {
  await chrome.storage.local.set({
    [PROGRESS_KEY]: { pct: Math.round(pct), step, steps, ts: Date.now() }
  });
}

/** Remove the progress entry — subscribers treat "no value" as "hide the bar". */
export async function clearProgress() {
  await chrome.storage.local.remove(PROGRESS_KEY);
}
