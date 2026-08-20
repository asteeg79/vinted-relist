/**
 * User-configurable settings, persisted in chrome.storage.local under one key.
 *
 * Reads always merge stored values over DEFAULT_SETTINGS, so adding a new setting here
 * is backward-compatible: existing users automatically pick up the new default until
 * they change it. The popup's settings screen is the UI for these.
 */
const SETTINGS_KEY = 'settings';

/**
 * The description template (KONZEPT §7.6): one sentence plus two or three facts. It lives
 * in the settings rather than in the prompt so the shape can be adjusted without a code
 * change — the model FILLS this, it does not invent it.
 *
 * Two things stay out on purpose: measurements (not readable from photos — an invented
 * waist width is a defect in the goods) and condition prose (the condition is a
 * confirmation-bound field; repeated in prose it could silently contradict the chosen
 * value).
 */
export const DEFAULT_DESCRIPTION_TEMPLATE = [
  'Ein Satz zum Artikel, danach zwei bis drei Fakten als eigene Zeilen:',
  '',
  '<Ein Satz, der das Stück beschreibt.>',
  '• Material: <Material>',
  '• Passform: <Passform>',
  '• Besonderheit: <z. B. Kapuze, Muster, Verschluss>',
  '',
  'Keine Maße, keine Angaben zum Zustand. Nur Fakten aus den erkannten Feldern; was nicht',
  'erkannt wurde, wird weggelassen statt geraten.'
].join('\n');

/**
 * The condition values a draft can carry, with the copy both UIs show.
 *
 * Shared rather than written out twice: the popup picks the pre-selection and the studio
 * renders the confirmation-bound field, and two hand-maintained lists are exactly how the
 * gate texts drifted apart before `gates.js` (see CONTEXT.md). The ids are ours, not
 * Vinted's — the mapping to `status_id` comes from the taxonomy lookup (Schritt 0b).
 */
export const CONDITION_OPTIONS = [
  { value: 'new_with_tags', label: 'Neu mit Etikett' },
  { value: 'new_without_tags', label: 'Neu ohne Etikett' },
  { value: 'very_good', label: 'Sehr gut' },
  { value: 'good', label: 'Gut' },
  { value: 'satisfactory', label: 'Zufriedenstellend' }
];

export const DEFAULT_SETTINGS = {
  deleteEnabled: true,        // false = test mode: create the clone but keep the original
  photoQuality: 0.92,         // JPEG quality for re-encode (0.6 – 0.98)
  cooldownWarnPerHour: 5,     // soft-warn threshold: relists in the last rolling hour
  cooldownWarnPer24h: 30,     // soft-warn threshold: relists in the last rolling 24h
  interestWarn: true,         // warn before relisting items that have favourites/views/chats
  verifyAfterCreate: true,    // re-fetch the new listing before deleting the original
  defaultColorId: 15,         // fallback colour ("Bunt"/VARIOUS) auto-applied on retry when
                              // the source item has no colour but the category requires one

  // --- Auto-Listing (ADR-0007) -------------------------------------------------------
  draftCreateEnabled: false,  // false = Trockenlauf: build the payload, log it, send nothing.
                              // The default, and it stays that way until the hit rate of
                              // the category detection has been measured on real items.
  draftLanguage: 'de',        // fixed choice, not derived from the domain: the texts are
                              // written during preparation, the target domain is only known
                              // when publishing (KONZEPT §7.7)
  draftConditionDefault: 'very_good', // pre-selected condition — a cursor position, never a
                              // statement: it counts as needs_confirmation until confirmed
  draftMinPrice: 0,           // 0 = off. Floor against a wrong category producing a wrong
                              // price range — a branded piece at t-shirt money
  draftConfidenceThreshold: 0.8, // below this a field blocks until the user confirms it
  draftDescriptionTemplate: DEFAULT_DESCRIPTION_TEMPLATE,
  cropCheckMode: 'all'        // 'all' | 'uncertain' — have the model check every cropped
                              // photo, or only the ones the heuristic was unsure about.
                              // 'all' while the thresholds are still being calibrated:
                              // selective checking would hide exactly the cases where the
                              // heuristic was wrongly confident.
};

/** Current settings = defaults with any stored overrides applied. */
export async function getSettings() {
  const { [SETTINGS_KEY]: stored } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

/** Merge a partial patch into the stored settings and return the full new object. */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Wipe overrides — next getSettings() returns pure defaults. */
export async function resetSettings() {
  await chrome.storage.local.remove(SETTINGS_KEY);
  return DEFAULT_SETTINGS;
}
