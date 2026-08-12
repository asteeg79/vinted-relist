/**
 * User-configurable settings, persisted in chrome.storage.local under one key.
 *
 * Reads always merge stored values over DEFAULT_SETTINGS, so adding a new setting here
 * is backward-compatible: existing users automatically pick up the new default until
 * they change it. The popup's settings screen is the UI for these.
 */
const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = {
  deleteEnabled: true,        // false = test mode: create the clone but keep the original
  photoQuality: 0.92,         // JPEG quality for re-encode (0.6 – 0.98)
  cooldownWarnPerHour: 5,     // soft-warn threshold: relists in the last rolling hour
  cooldownWarnPer24h: 30,     // soft-warn threshold: relists in the last rolling 24h
  interestWarn: true,         // warn before relisting items that have favourites/views/chats
  verifyAfterCreate: true,    // re-fetch the new listing before deleting the original
  defaultColorId: 15          // fallback colour ("Bunt"/VARIOUS) auto-applied on retry when
                              // the source item has no colour but the category requires one
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
