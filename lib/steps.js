/**
 * Die Phasen eines Laufs — was schon erledigt ist und was noch kommt.
 *
 * WARUM ES DAS BRAUCHT. Der Fortschritt bestand aus einer Zahl und einem Satz: „80 % —
 * Neuer Artikel wird erstellt…". Das sagt, wo man gerade ist, aber nicht, was hinter einem
 * liegt und was noch bevorsteht — und bei einer Pipeline, die am Ende etwas LÖSCHT, ist
 * genau das die Frage, die man sich beim Zusehen stellt.
 *
 * WARUM DIE PROZENTE REICHEN. Jede Phase meldet ihren Fortschritt ohnehin an einer festen
 * Marke an (`publishProgress(80, …)`), und die Marken sind aufsteigend. Aus der Zahl allein
 * lässt sich damit ableiten, in welcher Phase ein Lauf steht — ohne dass die Pipelines
 * einen zweiten Wert mitschicken müssten und ohne die Port-Schnittstelle zu verbreitern.
 *
 * WER DIE LISTE WÄHLT. Die Adapter (`live-port.js` für den Relist, `live-draft-port.js`
 * fürs Auto-Listing): sie sind die eine Stelle, die weiß, welche Pipeline sie bedient. Die
 * Oberflächen bekommen die fertige Liste über `chrome.storage` und zeichnen sie nur noch —
 * was besonders für das Content-Skript zählt, das gar keine Module importieren kann.
 */

/** Ein Schritt ist erledigt, läuft gerade, oder steht noch aus. */
export const STEP_DONE = 'done';
export const STEP_CURRENT = 'current';
export const STEP_TODO = 'todo';

/**
 * Die Phasen eines Relists, mit der Marke, an der jede beginnt.
 *
 * Die Beschriftungen sind Vorgänge, keine Meldungen: „Original löschen" steht auch dann
 * da, wenn es noch nicht passiert ist — das ist ja der Punkt. Die laufende Meldung
 * („Foto 2/5: hochladen…") steht weiterhin daneben und ist feiner als jede Phase.
 */
export const RELIST_STEPS = [
  { at: 0, label: 'Anmeldung prüfen' },
  { at: 10, label: 'Artikeldaten laden' },
  { at: 20, label: 'Fotos übertragen' },
  { at: 75, label: 'Neuen Artikel erstellen' },
  { at: 88, label: 'Neuen Artikel prüfen' },
  { at: 92, label: 'Original löschen' }
];

/** Dieselben Phasen fürs Auto-Listing — dort wird nichts gelöscht, dafür erkannt. */
export const DRAFT_STEPS = [
  { at: 0, label: 'Kategorie prüfen' },
  { at: 15, label: 'Fotos hochladen' },
  { at: 70, label: 'Gegenprobe bei Vinted' },
  { at: 80, label: 'Inserat bauen' },
  { at: 90, label: 'Inserat einstellen' }
];

/**
 * Die Phasenliste für einen Fortschritt in Prozent.
 *
 * Erledigt ist eine Phase, sobald die NÄCHSTE begonnen hat — nicht schon, wenn ihre eigene
 * Marke überschritten ist. Sonst stünde die laufende Phase als erledigt da, während sie
 * gerade arbeitet. Bei 100 % ist alles erledigt und nichts mehr aktuell.
 */
export function stepsAt(steps, pct) {
  const list = Array.isArray(steps) ? steps : [];
  const value = Number.isFinite(pct) ? pct : 0;

  return list.map((step, i) => {
    const next = list[i + 1];
    if (value >= 100) return { label: step.label, state: STEP_DONE };
    if (next && value >= next.at) return { label: step.label, state: STEP_DONE };
    if (value >= step.at && (!next || value < next.at)) return { label: step.label, state: STEP_CURRENT };
    return { label: step.label, state: STEP_TODO };
  });
}
