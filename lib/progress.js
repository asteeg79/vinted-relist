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

/** Publish a progress update. `pct` is rounded; `step` is a short human label. */
export async function setProgress(pct, step) {
  await chrome.storage.local.set({ [PROGRESS_KEY]: { pct: Math.round(pct), step, ts: Date.now() } });
}

/** Remove the progress entry — subscribers treat "no value" as "hide the bar". */
export async function clearProgress() {
  await chrome.storage.local.remove(PROGRESS_KEY);
}
