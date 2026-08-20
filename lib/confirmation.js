/**
 * The first-run confirmation flag.
 *
 * Once the user has acknowledged that relisting permanently deletes the original, we
 * don't ask again. The flag lived as a bare `'confirmedDelete'` string in five places
 * across popup.js and content.js; it lives here now so the gate that reads it and the
 * settings screen that clears it agree on one key.
 */
const CONFIRMED_KEY = 'confirmedDelete';

export async function hasConfirmedDelete() {
  const { [CONFIRMED_KEY]: confirmed = false } = await chrome.storage.local.get(CONFIRMED_KEY);
  return !!confirmed;
}

export async function setConfirmedDelete() {
  await chrome.storage.local.set({ [CONFIRMED_KEY]: true });
}

/** Re-arm the first-run gate (the "Erst-Bestätigung zurücksetzen" button). */
export async function resetConfirmedDelete() {
  await chrome.storage.local.remove(CONFIRMED_KEY);
}

/**
 * The same idea for the auto-listing's first LIVE create (ADR-0007, Entscheidung 4).
 *
 * A separate flag on purpose: acknowledging that a relist deletes the original says
 * nothing about being ready to put a machine-written listing in front of buyers. The
 * dry run is the default until this is set once.
 */
const CONFIRMED_CREATE_KEY = 'confirmedCreate';

export async function hasConfirmedCreate() {
  const { [CONFIRMED_CREATE_KEY]: confirmed = false } = await chrome.storage.local.get(CONFIRMED_CREATE_KEY);
  return !!confirmed;
}

export async function setConfirmedCreate() {
  await chrome.storage.local.set({ [CONFIRMED_CREATE_KEY]: true });
}

export async function resetConfirmedCreate() {
  await chrome.storage.local.remove(CONFIRMED_CREATE_KEY);
}
