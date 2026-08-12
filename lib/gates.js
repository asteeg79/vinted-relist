/**
 * Relist gates — the confirmations a relist must clear before the destructive pipeline
 * runs, and the message shown when it finishes.
 *
 * Both UIs (the popup and the on-page toast) used to re-derive these decisions
 * independently, and had already drifted: two copies of DEFAULT_SETTINGS, two cooldown
 * checks reading settings differently, two interest checks with different shapes, two
 * outcome→text mappings. This module is the single place that decides; the UIs only
 * render.
 *
 * HOW EACH UI GETS THESE: gates are computed in `preflight()` (lib/relist.js) and the
 * outcome message in the service worker's message router, so both travel over the
 * existing `relist/preflight` and `relist/run` messages. That matters because a content
 * script declared in the manifest cannot use ESM imports — routing the decision through
 * the message seam both UIs already cross avoids a build step.
 *
 * Pure: no chrome.*, no DOM, no I/O.
 */

/** Gate kinds. The first-run gate is the one whose acceptance is remembered. */
export const GATE_FIRST_RUN = 'first_run';
export const GATE_COOLDOWN = 'cooldown';
export const GATE_INTEREST = 'interest';

/**
 * The gates for one relist, in the order they must be shown.
 *
 * A Gate is { kind, title, text, lines, note, remember } — `lines` is always an array
 * (often empty) and `note` always a string, so a renderer never has to test for absence.
 * `remember` says whether accepting this gate should be persisted so it isn't asked
 * again; the UI acts on the flag rather than matching on `kind`, which keeps the answer
 * here even for the content script, which can't import GATE_FIRST_RUN.
 *
 * Inputs:
 *   interest        { favourites, views, conversations } from the source item
 *   counts          { lastHour, last24h } rolling relist counts
 *   settings        the full merged settings object
 *   confirmedDelete has the user already accepted the first-run warning?
 */
export function gatesFor({ interest = {}, counts = {}, settings = {}, confirmedDelete = false } = {}) {
  const gates = [];

  // 1. First run: the only gate that explains the deletion itself. Skipped entirely in
  //    test mode, where nothing is deleted.
  if (settings.deleteEnabled && !confirmedDelete) {
    gates.push({
      kind: GATE_FIRST_RUN,
      title: 'Erster Lauf',
      text: 'Der Originalartikel wird nach erfolgreichem Klon dauerhaft gelöscht.',
      lines: [],
      note: 'Fortfahren?',
      remember: true
    });
  }

  // 2. Cooldown: a soft warning once the user is relisting often enough to look like a
  //    pattern to Vinted's anti-bot heuristics.
  const lastHour = counts.lastHour || 0;
  const last24h = counts.last24h || 0;
  if (lastHour >= settings.cooldownWarnPerHour || last24h >= settings.cooldownWarnPer24h) {
    gates.push({
      kind: GATE_COOLDOWN,
      title: 'Vorsicht: viele Bumps',
      text: `Du hast schon ${lastHour} Bumps in der letzten Stunde und ${last24h} in den letzten 24 h gemacht.`,
      lines: [],
      note: 'Vinted erkennt Patterns — lieber pausieren.',
      remember: false
    });
  }

  // 3. Interest: favourites/views/chats are lost when the listing is recreated, so the
  //    user gets to see what they're giving up. Only non-zero metrics are listed.
  if (settings.interestWarn !== false) {
    const lines = [
      ['Favoriten', interest.favourites],
      ['Aufrufe', interest.views],
      ['Gespräche', interest.conversations]
    ].filter(([, v]) => v > 0).map(([label, v]) => `${label}: ${v}`);

    if (lines.length) {
      gates.push({
        kind: GATE_INTEREST,
        title: 'Aktives Interesse erkannt',
        text: 'Dieser Artikel hat:',
        lines,
        note: 'Beim Relist gehen diese Daten verloren.',
        remember: false
      });
    }
  }

  return gates;
}

/**
 * The message for a completed relist. Takes the pipeline's return value and produces
 * { kind, text, newId, newUrl, oldId, oldUrl, autoHideMs } — the decision, not the
 * markup, so the popup can render links and the toast can render a coloured box.
 *
 * `kind` ∈ 'ok' | 'warning' | 'error', matching the CSS classes both UIs already use.
 */
export function describeOutcome(result = {}) {
  const common = { newId: result.newId, newUrl: result.newUrl };

  if (result.testMode) {
    return {
      kind: 'warning',
      text: 'Test-Modus: Klon erstellt, Original wurde NICHT gelöscht.',
      oldId: result.oldId,
      oldUrl: result.oldUrl,
      autoHideMs: 6000,
      ...common
    };
  }
  if (result.partial) {
    return { kind: 'warning', text: result.warning, autoHideMs: 10000, ...common };
  }
  return { kind: 'ok', text: 'Fertig.', autoHideMs: 6000, ...common };
}

/** The message for a relist that threw. Mirrors describeOutcome's shape. */
export function describeFailure(error) {
  return {
    kind: 'error',
    text: 'Fehler: ' + (error?.message || error || 'unbekannt'),
    autoHideMs: 10000
  };
}
