/**
 * Der Zustand — Vinteds fünf Stufen, einmal aufgeschrieben.
 *
 * WARUM DIESE DATEI. Drei Stellen brauchen dasselbe Vokabular und dürfen nicht
 * auseinanderlaufen: die Einstellungen bieten eine Voreinstellung an, die KI soll den
 * Zustand vorschlagen, und die Auflösung muss aus dem Vorschlag eine echte `status_id`
 * machen. Vorher lag das Vokabular in `settings.js` und die Zuordnung in `lookup.js`, und
 * die beiden passten nicht zusammen — "Neu ohne Etikett" heißt bei Vinted schlicht "Neu",
 * also traf der Abgleich über die Beschriftung genau die zwei Fälle nicht, für die er da
 * war.
 *
 * IDS STEHEN HIER NICHT DRIN, UND DAS IST ABSICHT (ADR-0005). Gemessen wurden sie sehr
 * wohl — am 2026-08-20 auf `www.vinted.de`:
 *
 *     6 = Neu, mit Etikett      1 = Neu      2 = Sehr gut      3 = Gut
 *     4 = Zufriedenstellend                  (7 = Nicht voll funktionsfähig)
 *
 * "Sehr gut" ist die 2 und nicht die 3 — genau die Sorte Zahl, bei der Raten teuer wird.
 * Trotzdem stehen sie nur im Kommentar: die Zahlen gehören Vinted, sie sind pro Markt
 * verschieden, und die 7 taucht in `/api/v2/statuses` auf, aber NICHT in der Liste, die
 * `/api/v2/item_upload/conditions` fürs Einstellen zurückgibt. Zur Laufzeit gefragt ist
 * das immer richtig, hier hartkodiert wäre es irgendwann still falsch.
 *
 * Rein: kein chrome.*, kein DOM, kein I/O.
 */
import { normaliseLabel } from './resolve.js';

/**
 * Die fünf Stufen, in Vinteds eigener Reihenfolge (neu → gebraucht).
 *
 *   value       das Symbol, das in den Einstellungen und in der KI-Antwort steht
 *   label       was der Nutzer im Auswahlfeld liest — "Neu" allein wäre dort rätselhaft,
 *               deshalb steht in der Oberfläche die deutlichere Fassung
 *   titles      wie Vinted es schreibt. Mehrere, weil die Schreibweise sich ändert
 *               (Komma mal ja, mal nein) und ältere Märkte "Preisschild" sagen
 *   definition  Vinteds eigene Erklärung, wortgleich aus der API. Die geht so in den
 *               Prompt: die KI soll nach Vinteds Maßstab urteilen, nicht nach ihrem
 */
export const CONDITIONS = [
  {
    value: 'new_with_tags',
    label: 'Neu mit Etikett',
    titles: ['Neu, mit Etikett', 'Neu mit Etikett', 'Neu mit Preisschild'],
    definition: 'Ein brandneuer, unbenutzter Artikel mit Etikett oder original verpackt.'
  },
  {
    value: 'new_without_tags',
    label: 'Neu ohne Etikett',
    titles: ['Neu', 'Neu ohne Etikett', 'Neu ohne Preisschild'],
    definition: 'Ein brandneuer, unbenutzter Artikel ohne Etikett oder Originalverpackung.'
  },
  {
    value: 'very_good',
    label: 'Sehr gut',
    titles: ['Sehr gut'],
    definition: 'Ein nur selten benutzter Artikel mit möglichen Unvollkommenheiten, aber sonst im Top-Zustand.'
  },
  {
    value: 'good',
    label: 'Gut',
    titles: ['Gut'],
    definition: 'Ein benutzter Artikel mit möglichen Mängeln und Gebrauchsspuren.'
  },
  {
    value: 'satisfactory',
    label: 'Zufriedenstellend',
    titles: ['Zufriedenstellend'],
    definition: 'Ein oft benutzter Artikel mit Mängeln und Gebrauchsspuren.'
  }
];

/** Die Symbole als Liste — das Enum für das KI-Schema. */
export const CONDITION_VALUES = CONDITIONS.map(c => c.value);

/** Ein Symbol nachschlagen. Unbekanntes ist null, nie ein Notbehelf. */
export const conditionByValue = value => CONDITIONS.find(c => c.value === value) || null;

/**
 * Symbol → Vinteds `status_id`, gegen die Liste, die Vinted gerade zurückgegeben hat.
 *
 * Findet sich nichts, ist die Antwort null und das Feld bleibt leer. Das ist der teure,
 * aber richtige Ausgang: ein Zustand, den niemand ausgewählt hat, steht sonst rechtsgültig
 * in einem öffentlichen Inserat (§7.5).
 */
export function conditionIdFor(conditions, value) {
  const entry = conditionByValue(value);
  if (!entry) return null;
  const wanted = entry.titles.map(normaliseLabel);
  const hit = (conditions || []).find(c => wanted.includes(normaliseLabel(c?.title)));
  return hit ? hit.id : null;
}

/**
 * Vinteds id → Vinteds eigener Titel, zum Anzeigen.
 *
 * Nicht `conditionByValue(...).label`: auf dem Bildschirm soll das Wort stehen, das auch
 * im Auswahlfeld steht, und das kommt von Vinted. Ist die Liste noch nicht geholt, ist die
 * Antwort null — der Aufrufer entscheidet, ob er dann die nackte id zeigt.
 */
export function conditionTitleFor(conditions, id) {
  if (id == null) return null;
  const hit = (conditions || []).find(c => String(c?.id) === String(id));
  return hit?.title ?? null;
}

/** Rückweg: Vinteds id → unser Symbol. Für Anzeige und Protokoll. */
export function conditionValueFor(conditions, id) {
  if (id == null) return null;
  const hit = (conditions || []).find(c => String(c?.id) === String(id));
  if (!hit) return null;
  const title = normaliseLabel(hit.title);
  return CONDITIONS.find(c => c.titles.map(normaliseLabel).includes(title))?.value ?? null;
}

/**
 * Welcher Zustand vorausgewählt wird, und woher er kommt.
 *
 * Zwei Quellen, in dieser Reihenfolge:
 *   1. die KI, wenn sie sich sicher genug war — sie hat die Fotos gesehen, die
 *      Einstellung hat das nicht
 *   2. sonst die Voreinstellung aus den Einstellungen ("Sehr gut")
 *
 * Die Schwelle ist dieselbe wie für Marke und Art (`draftConfidenceThreshold`): unterhalb
 * davon ist die Antwort der KI ein Eindruck und kein Befund, und dann ist die
 * Voreinstellung ehrlicher, weil jeder weiß, dass sie eine Voreinstellung ist.
 *
 * Beides ist eine Cursorposition, kein Urteil: `draft-view.js` verlangt für den Zustand in
 * jedem Fall eine Bestätigung, gleich woher der Wert stammt.
 *
 * Gibt `{ id, source, value, evidence }` zurück — `source` ist 'ai', 'default' oder null.
 */
export function chooseCondition({ conditions = [], analysis = null, settings = {} } = {}) {
  const none = { id: null, source: null, value: null, evidence: null };
  if (!conditions.length) return none;

  const threshold = settings.draftConfidenceThreshold ?? 0.8;
  const guess = analysis?.condition ?? null;
  const sure = typeof analysis?.condition_confidence === 'number' && analysis.condition_confidence >= threshold;

  if (guess && sure) {
    const id = conditionIdFor(conditions, guess);
    if (id != null) {
      return { id, source: 'ai', value: guess, evidence: analysis.condition_evidence || null };
    }
  }

  const fallback = settings.draftConditionDefault ?? 'very_good';
  const id = conditionIdFor(conditions, fallback);
  return id == null ? none : { id, source: 'default', value: fallback, evidence: null };
}
