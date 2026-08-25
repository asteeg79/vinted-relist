/**
 * Progress reporting for the relist pipeline.
 *
 * The pipeline runs in the service worker, but the UI lives in two other contexts
 * (the popup and the on-page toast). Rather than message each one directly, the SW
 * writes the current {pct, step} to chrome.storage.local; both UIs subscribe via
 * chrome.storage.onChanged and re-render. This decouples producer from consumers and
 * survives the popup being closed/reopened mid-run (it reads the last value on open).
 */
import { stepsAt } from './steps.js';

/** Exported so subscribers (the popup) watch the same key this module writes. */
export const PROGRESS_KEY = 'progress';

/**
 * Publish a progress update. `pct` is rounded; `step` is a short human label.
 *
 * `phases` ist die PHASENTABELLE der laufenden Pipeline (`RELIST_STEPS` / `DRAFT_STEPS`) —
 * welche das ist, weiß der Adapter, und nur er. Die fertige Liste — was erledigt ist, was
 * läuft, was aussteht — wird hier daraus gerechnet und reist im Datensatz mit, weil eine
 * der beiden Oberflächen sie sich nicht selbst ausrechnen kann: das Content-Skript ist als
 * Manifest-Skript geladen und darf keine Module importieren (ADR-0006). Es zeichnet, was
 * hier steht.
 */
export async function setProgress(pct, step, phases = []) {
  // EINE ZAHL, EINMAL GERUNDET, beide Angaben daraus. Vorher bekam `stepsAt` das
  // ungerundete `pct`, gespeichert wurde das gerundete: bei 74,6 stand `pct: 75` im
  // Datensatz — genau auf der Marke der nächsten Phase —, während die Liste noch die
  // vorige als laufend führte. Der Balken saß auf der Grenze, die Liste eine Phase davor.
  const value = Math.round(Number.isFinite(pct) ? pct : 0);
  await chrome.storage.local.set({
    [PROGRESS_KEY]: { pct: value, step, steps: stepsAt(phases, value), ts: Date.now() }
  });
}

/** Remove the progress entry — subscribers treat "no value" as "hide the bar". */
export async function clearProgress() {
  await chrome.storage.local.remove(PROGRESS_KEY);
}
