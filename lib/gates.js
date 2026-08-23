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

/** The auto-listing's own first-run gate — the first time the dry run is switched off. */
export const GATE_FIRST_CREATE = 'first_create';

/**
 * The gates for publishing a draft (ADR-0007, Entscheidung 4).
 *
 * A separate flag from the relist's first-run gate on purpose: having accepted that a
 * relist deletes the original says nothing about being ready to put a machine-written
 * listing in front of buyers. It is only asked once the dry run has actually been turned
 * off — in the dry run nothing becomes public, so there is nothing to warn about.
 */
export function draftGatesFor({ settings = {}, confirmedCreate = false } = {}) {
  const gates = [];

  if (settings.draftCreateEnabled && !confirmedCreate) {
    gates.push({
      kind: GATE_FIRST_CREATE,
      title: 'Erstes echtes Inserat',
      text: 'Der Testlauf ist aus. Dieses Inserat wird wirklich bei Vinted eingestellt und ist danach öffentlich sichtbar.',
      lines: [],
      note: 'Für die Angaben haftest du, nicht das Modell — prüfe Titel, Zustand und Preis noch einmal.',
      remember: true
    });
  }

  return gates;
}

/**
 * Das Schild oben rechts im Studio — die eine Frage, die vor dem Klick zählt: entsteht
 * hier ein echtes Inserat, oder nicht?
 *
 * KEINE STUFEN MEHR. Vorher stand dort die Stufe aus §4.1 des Konzepts. Die ist eine
 * Entwicklungslandkarte und beantwortet nicht, was der nächste Klick bewirkt — sie war
 * sogar veraltet, während die Oberfläche längst hochlud. Wer auf „Veröffentlichen" zeigt,
 * will genau eines wissen, und das steht jetzt da.
 *
 * Zwei Zustände, mehr gibt es nicht: `draftCreateEnabled` ist an oder aus.
 *
 * Schild, Knopfbeschriftung und der Satz darunter kommen zusammen von hier, weil sie
 * dasselbe sagen müssen. Vorher stand oben „Testlauf" und unten „Trockenlauf" — zwei Wörter
 * für eine Sache, entschieden an zwei Stellen.
 */
export function publishModeNote({ settings = {} } = {}) {
  return settings.draftCreateEnabled
    ? {
      kind: 'live',
      text: 'Scharf — Inserate werden bei Vinted angelegt',
      button: 'Veröffentlichen',
      hint: 'Das Inserat wird wirklich eingestellt und ist danach öffentlich sichtbar.'
    }
    : {
      kind: 'dry',
      text: 'Testlauf — kein Inserat wird angelegt',
      button: 'Testlauf starten',
      // „bei Vinted entsteht nichts" wäre falsch: der Testlauf lädt jedes Foto hoch und
      // fragt Vinteds Erkennung — nur der Create unterbleibt. Was entsteht, ist kein
      // Inserat, und genau so steht es da.
      hint: 'Testlauf: Fotos gehen hoch, die Payload ins Log — ein Inserat entsteht nicht.'
    };
}

/**
 * Die Rückfrage vor dem Leeren des Studios — oder null, wenn es nichts zu fragen gibt.
 *
 * Zwei Lagen brauchen keine: ein leeres Formular (nichts zu verlieren) und eines, aus dem
 * das Inserat schon entstanden ist (die Arbeit ist getan, das Leeren ist der nächste
 * Schritt). Dazwischen liegt der teure Fall — Fotos und Texte sind nur im Tab, ein
 * Fehlklick wirft eine Viertelstunde weg.
 */
export function resetGateFor({ hasWork = false, published = false } = {}) {
  if (!hasWork || published) return null;
  return {
    kind: 'reset_draft',
    title: 'Studio leeren?',
    text: 'Fotos, Erkennung und alle Angaben dieses Artikels werden verworfen.',
    lines: [],
    note: 'Die Fotos liegen nur in diesem Tab — sie sind danach weg.',
    remember: false
  };
}

/**
 * The message for a finished publish attempt. Same shape as `describeOutcome`, so both
 * UIs can render it with the code they already have.
 *
 * The three outcomes are the ones CONTEXT.md names, and the middle one is why this is
 * separate from the relist: a dry run is neither a success nor a failure.
 *
 * SPRACHREGELUNG: intern und in den Docs heißt der Zustand „Trockenlauf"; auf dem
 * Bildschirm steht überall „Testlauf". Zwei Wörter für eine Sache waren genau das
 * Durcheinander, das `publishModeNote` aufgeräumt hat — die Oberfläche kennt nur eines.
 */
export function describeDraftOutcome(result = {}) {
  // Not an error: two recognisers looked at the same photos and said different things,
  // which is the whole reason the cross-check exists (Entscheidung C). The fields are now
  // open in the studio with both answers to choose from. The re-upload is named because it
  // is a real cost — the photos are bound to a session that this attempt just abandoned.
  if (result.conflict) {
    return {
      kind: 'warning',
      text: `Vinteds eigene Erkennung sieht es anders: ${(result.blockers || []).join(' · ')}. `
        + 'Die betroffenen Felder stehen oben zur Auswahl — danach erneut veröffentlichen '
        + '(die Fotos werden dabei neu hochgeladen).'
    };
  }
  if (result.dryRun) {
    return {
      kind: 'warning',
      text: 'Testlauf: Payload gebaut und ins Log geschrieben — es wurde kein Inserat eingestellt.',
      autoHideMs: 8000
    };
  }
  return {
    kind: 'ok',
    text: `Eingestellt: ${result.title || 'Inserat'}`,
    newId: result.newId,
    newUrl: result.newUrl,
    autoHideMs: 8000
  };
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
