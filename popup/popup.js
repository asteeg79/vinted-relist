/**
 * Popup UI controller.
 *
 * The popup is a thin front-end: it collects the item URL, walks the user through
 * whatever gates the service worker hands back, then asks it to do the work
 * (relist/preflight + relist/run). It renders live progress, the log tail, the relist
 * history + cooldown counters, and the settings screen.
 *
 * It DECIDES NOTHING. Which warnings to show, in what order, with what copy, and what
 * the final message says all come from lib/gates.js via the service worker — the popup
 * and the on-page toast used to each have their own copy of those rules and had already
 * drifted apart. This file is an ES module (see popup.html) so the settings screen and
 * history list read the real lib/* modules rather than mirroring them.
 */
import { getSettings, saveSettings, DEFAULT_DESCRIPTION_TEMPLATE, CONDITION_OPTIONS } from '../lib/settings.js';
import { storeKey, unlockKey, hasStoredKey, readCachedKey, clearKey, describeKeyState } from '../lib/secret.js';
import { parseUrl } from '../lib/item.js';
import { PROGRESS_KEY } from '../lib/progress.js';
import { LOG_KEY, clearLog } from '../lib/logger.js';
import { getHistory, countWindows, clearHistory, HISTORY_KEY } from '../lib/history.js';
import { resetConfirmedDelete } from '../lib/confirmation.js';
import { publishModeNote } from '../lib/gates.js';

const $ = id => document.getElementById(id);

// ---------- Status / progress helpers ----------
/** Set the status line. `kind` ∈ '', 'working', 'ok', 'error' (drives the colour). */
function setStatus(text, kind = '') {
  const el = $('status');
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.innerHTML = text; // trusted: we only ever pass our own strings + links here
}

/** Toggle the main button's spinner + disabled state. */
function setLoading(loading) {
  const btn = $('go');
  btn.classList.toggle('is-loading', loading);
  btn.disabled = loading;
}

function showProgress(pct, step, steps) {
  $('progress').hidden = false;
  $('progressStep').textContent = step || '';
  renderSteps(steps);
  $('progressFill').style.width = `${pct}%`;
  $('progressPct').textContent = `${Math.round(pct)}%`;
}

/**
 * Die Phasenliste — erledigt, laufend, ausstehend.
 *
 * Das Zeichen sagt die Lage auch dann, wenn jemand die Farben nicht unterscheidet; das ist
 * derselbe Aufbau wie im Toast auf der Vinted-Seite, damit man nicht zwei Darstellungen
 * lernen muss.
 */
function renderSteps(steps) {
  const list = $('progressSteps');
  list.replaceChildren(...(steps || []).map(s => {
    const li = document.createElement('li');
    li.className = 'progress-phase is-' + s.state;
    const mark = document.createElement('span');
    mark.className = 'progress-mark';
    mark.textContent = s.state === 'done' ? '✓' : (s.state === 'current' ? '▸' : '·');
    const text = document.createElement('span');
    text.textContent = s.label;
    li.append(mark, text);
    return li;
  }));
}

function hideProgress() {
  $('progress').hidden = true;
  $('progressFill').style.width = '0%';
  $('progressPct').textContent = '0%';
  $('progressStep').textContent = '';
  renderSteps([]);
}

// Subscribe to storage so the bar + history update live while the SW works (even though
// the SW, not the popup, is the producer).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[PROGRESS_KEY]) {
    const p = changes[PROGRESS_KEY].newValue;
    if (p && typeof p.pct === 'number') showProgress(p.pct, p.step, p.steps);
    else hideProgress(); // progress cleared → hide
  }
  if (changes[HISTORY_KEY]) renderHistory();
});

// If the popup is (re)opened mid-run, restore the current progress immediately.
chrome.storage.local.get(PROGRESS_KEY, ({ [PROGRESS_KEY]: progress }) => {
  if (progress && typeof progress.pct === 'number' && progress.pct < 100) {
    showProgress(progress.pct, progress.step, progress.steps);
  }
});

async function refreshLog() {
  const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
  $('log-output').textContent = log.slice(-30).join('\n'); // tail only
}

/** Loose client-side check before we bother the SW — same rules as the pipeline's. */
function isValidVintedItemUrl(url) {
  try { parseUrl(url); return true; } catch { return false; }
}

// ---------- History + cooldown counters ----------
/** Compact timestamp: time-of-day for today's entries, date+time otherwise. */
function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const opts = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString('de-DE', opts);
}

/** Paint the cooldown counter chips from an already-loaded history. */
function renderCounters(entries) {
  const counts = countWindows(entries);
  $('countHour').textContent = String(counts.lastHour);
  $('count24h').textContent = String(counts.last24h);
}

/** Render the (up to 30) most recent relists as links, then refresh the counters. */
async function renderHistory() {
  const entries = await getHistory();
  const list = $('historyList');
  list.innerHTML = '';
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Noch keine Einträge.';
    list.appendChild(li);
  } else {
    for (const e of entries.slice(0, 30)) {
      const li = document.createElement('li');
      const title = document.createElement('a');
      title.className = 'history-title';
      title.href = `https://www.${e.domain || 'vinted.de'}/items/${e.newId}`;
      title.target = '_blank';
      title.textContent = (e.testMode ? '[Test] ' : '') + (e.title || `Item ${e.oldId}`);
      const time = document.createElement('span');
      time.className = 'history-time';
      time.textContent = formatTime(e.ts);
      li.appendChild(title);
      li.appendChild(time);
      list.appendChild(li);
    }
  }
  renderCounters(entries);
}

// ---------- Gate rendering (Promise<boolean>) ----------
/**
 * Show one gate from lib/gates.js and resolve true/false on its two buttons.
 * Used instead of window.confirm(), which closes the popup. The handlers are nulled on
 * cleanup so repeated opens don't stack listeners.
 *
 * The popup only renders — it never decides which gates exist or what they say.
 */
function askGate(gate) {
  return new Promise(resolve => {
    $('gateTitle').textContent = gate.title;
    $('gateText').textContent = gate.text || '';
    $('gateText').hidden = !gate.text;
    $('gateNote').textContent = gate.note || '';
    $('gateNote').hidden = !gate.note;

    const list = $('gateLines');
    list.innerHTML = '';
    list.hidden = !gate.lines?.length;
    for (const line of gate.lines || []) {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }

    const box = $('gateBox');
    box.hidden = false;
    const cleanup = (result) => {
      box.hidden = true;
      $('gateProceed').onclick = null;
      $('gateCancel').onclick = null;
      resolve(result);
    };
    $('gateProceed').onclick = () => cleanup(true);
    $('gateCancel').onclick = () => cleanup(false);
  });
}

// ---------- URL auto-fill ----------
// If the active tab is itself a Vinted item page, pre-fill the URL field.
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab?.url && isValidVintedItemUrl(tab.url)) {
    $('url').value = tab.url;
  }
});

// ---------- Main relist flow ----------
$('go').addEventListener('click', async () => {
  const url = $('url').value.trim();
  if (!isValidVintedItemUrl(url)) {
    setStatus('Bitte gib eine gültige Vinted-Artikel-URL ein.', 'error');
    return;
  }

  // 1. Preflight: non-destructive: reports the item's interest, the cooldown counts, and
  //    the ordered gates the user must clear. Every decision below was made in
  //    lib/gates.js — this file only shows them.
  setLoading(true);
  setStatus('Prüfe Artikel…', 'working');
  let preflight;
  try {
    preflight = await chrome.runtime.sendMessage({ type: 'relist/preflight', url });
    if (!preflight?.ok) throw new Error(preflight?.error || 'Preflight fehlgeschlagen');
  } catch (e) {
    setStatus('Fehler: ' + e.message, 'error');
    setLoading(false);
    return;
  }

  // 2. Walk the gates in order; any refusal aborts.
  for (const gate of preflight.gates || []) {
    setStatus('', '');
    const proceed = await askGate(gate);
    if (!proceed) { setStatus('Abgebrochen.', 'error'); setLoading(false); return; }
    // Accepting the first-run gate is remembered so it isn't asked again.
    if (gate.remember) await chrome.runtime.sendMessage({ type: 'relist/confirmed' });
  }

  // 3. Run the pipeline. The progress bar updates itself via the storage subscription.
  setStatus('', '');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'relist/run', url });
    const message = res?.message || { kind: 'error', text: 'Fehler: unbekannt' };
    setStatus(renderMessage(message), message.kind);
  } catch (e) {
    setStatus('Fehler: ' + e.message, 'error');
  } finally {
    setLoading(false);
    refreshLog();
    renderHistory();
  }
});

// The studio needs its own tab: the popup dies on every click beside it, which makes it
// useless for drag & drop, preview and review (ADR-0007).
$('openStudio').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('studio/studio.html') });
});

/** Turn a gates.js message into the popup's HTML, appending links when it carries ids. */
function renderMessage(message) {
  const parts = [escapeHtml(message.text || '')];
  if (message.newUrl && message.newId) {
    parts.push(`Neu: <a href="${message.newUrl}" target="_blank">${message.newId}</a>`);
  }
  if (message.oldUrl && message.oldId) {
    parts.push(`Original: <a href="${message.oldUrl}" target="_blank">${message.oldId}</a>`);
  }
  return parts.join('<br>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Log buttons ----------
$('clearLog').addEventListener('click', async (e) => {
  e.preventDefault();
  await clearLog();
  refreshLog();
});

// Copy a support-friendly bundle: version + URL + status + full log.
$('copyLog').addEventListener('click', async (e) => {
  e.preventDefault();
  const btn = e.currentTarget;
  const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
  const statusText = $('status').innerText.trim();
  const v = chrome.runtime.getManifest().version;
  const parts = [
    `Vinted Relist v${v}`,
    `URL: ${$('url').value || '(leer)'}`,
    `Status: ${statusText || '(leer)'}`,
    '',
    '--- Log ---',
    log.length ? log.join('\n') : '(leer)'
  ];
  try {
    await navigator.clipboard.writeText(parts.join('\n'));
    btn.classList.add('copied');
    btn.textContent = 'Kopiert ✓';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = 'Log & Fehler kopieren'; }, 1500);
  } catch {
    btn.textContent = 'Fehler beim Kopieren';
    setTimeout(() => { btn.textContent = 'Log & Fehler kopieren'; }, 1500);
  }
});

$('clearHistory').addEventListener('click', async (e) => {
  e.preventDefault();
  await clearHistory();
  renderHistory();
});

// ---------- Settings view (simple two-screen toggle) ----------
$('openSettings').addEventListener('click', async () => {
  // Wer die Einstellungen neu öffnet, fängt beim Schlüssel von vorn an — sonst bliebe das
  // Ersetzen-Formular stehen, und es gäbe keinen Weg zurück außer dem Popup zu schließen.
  forceSetup = false;
  await loadSettingsIntoForm();
  $('viewMain').hidden = true;
  $('viewSettings').hidden = false;
});

$('closeSettings').addEventListener('click', () => {
  $('viewSettings').hidden = true;
  $('viewMain').hidden = false;
  renderHistory(); // counters may have changed while away
});

/** Populate the settings form controls from stored settings. */
async function loadSettingsIntoForm() {
  const s = await getSettings();
  $('setDelete').checked = !!s.deleteEnabled;
  $('setInterest').checked = !!s.interestWarn;
  $('setVerify').checked = !!s.verifyAfterCreate;
  const quality = Math.round((s.photoQuality || 0.92) * 100); // store 0–1, show 0–100
  $('setQuality').value = quality;
  $('qualityValue').textContent = quality;
  $('setWarnHour').value = s.cooldownWarnPerHour;
  $('setWarn24h').value = s.cooldownWarnPer24h;

  // Auto-listing
  $('setDraftCreate').checked = !!s.draftCreateEnabled;
  $('setDraftLanguage').value = s.draftLanguage;
  fillConditionOptions($('setDraftCondition'));
  $('setDraftCondition').value = s.draftConditionDefault;
  $('setCropCheck').value = s.cropCheckMode;
  const confidence = Math.round((s.draftConfidenceThreshold || 0.8) * 100);
  $('setConfidence').value = confidence;
  $('confidenceValue').textContent = confidence;
  $('setMinPrice').value = s.draftMinPrice;
  $('setTemplate').value = s.draftDescriptionTemplate;
  renderDraftCreateHint();
  await refreshKeyStatus();
}

/** Fill a <select> from the shared condition list, so popup and studio can't drift. */
function fillConditionOptions(select) {
  if (select.options.length) return;
  for (const { value, label } of CONDITION_OPTIONS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
}

/** Wire a checkbox to auto-save its setting on change. */
function bindAutosave(id, getter) {
  $(id).addEventListener('change', async () => {
    await saveSettings(getter());
    flashSaved();
  });
}

/** Briefly show "Gespeichert ✓" in the settings footer. */
function flashSaved() {
  const hint = $('saveHint');
  hint.textContent = 'Gespeichert ✓';
  hint.style.color = 'var(--ok-fg)';
  setTimeout(() => {
    hint.textContent = 'Änderungen werden automatisch gespeichert.';
    hint.style.color = '';
  }, 1200);
}

bindAutosave('setDelete', () => ({ deleteEnabled: $('setDelete').checked }));
bindAutosave('setInterest', () => ({ interestWarn: $('setInterest').checked }));
bindAutosave('setVerify', () => ({ verifyAfterCreate: $('setVerify').checked }));

// Quality slider: live label on input, persist on change (÷100 back to the 0–1 range).
$('setQuality').addEventListener('input', () => {
  $('qualityValue').textContent = $('setQuality').value;
});
$('setQuality').addEventListener('change', async () => {
  await saveSettings({ photoQuality: parseInt($('setQuality').value, 10) / 100 });
  flashSaved();
});

// Cooldown thresholds: clamp to a sane minimum of 1, persist on change.
$('setWarnHour').addEventListener('change', async () => {
  const v = Math.max(1, parseInt($('setWarnHour').value, 10) || 5);
  $('setWarnHour').value = v;
  await saveSettings({ cooldownWarnPerHour: v });
  flashSaved();
});
$('setWarn24h').addEventListener('change', async () => {
  const v = Math.max(1, parseInt($('setWarn24h').value, 10) || 30);
  $('setWarn24h').value = v;
  await saveSettings({ cooldownWarnPer24h: v });
  flashSaved();
});

// Re-arm the first-run confirmation dialog.
$('resetConfirm').addEventListener('click', async (e) => {
  e.preventDefault();
  await resetConfirmedDelete();
  const btn = e.currentTarget;
  btn.textContent = 'Zurückgesetzt ✓';
  setTimeout(() => { btn.textContent = 'Erst-Bestätigung zurücksetzen'; }, 1500);
});

// ---------- Auto-listing settings ----------
bindAutosave('setDraftCreate', () => ({ draftCreateEnabled: $('setDraftCreate').checked }));
// Der Schalter, der als einziger entscheidet, ob etwas öffentlich wird — der Satz darunter
// wechselt sofort mit, nicht erst beim nächsten Öffnen.
$('setDraftCreate').addEventListener('change', renderDraftCreateHint);
bindAutosave('setDraftLanguage', () => ({ draftLanguage: $('setDraftLanguage').value }));
bindAutosave('setDraftCondition', () => ({ draftConditionDefault: $('setDraftCondition').value }));
bindAutosave('setCropCheck', () => ({ cropCheckMode: $('setCropCheck').value }));
bindAutosave('setTemplate', () => ({ draftDescriptionTemplate: $('setTemplate').value }));

// Confidence: live label on input, persist on change (÷100 back to the 0–1 range).
$('setConfidence').addEventListener('input', () => {
  $('confidenceValue').textContent = $('setConfidence').value;
});
$('setConfidence').addEventListener('change', async () => {
  await saveSettings({ draftConfidenceThreshold: parseInt($('setConfidence').value, 10) / 100 });
  flashSaved();
});

$('setMinPrice').addEventListener('change', async () => {
  const v = Math.max(0, parseInt($('setMinPrice').value, 10) || 0);
  $('setMinPrice').value = v;
  await saveSettings({ draftMinPrice: v });
  flashSaved();
});

$('resetTemplate').addEventListener('click', async (e) => {
  e.preventDefault();
  $('setTemplate').value = DEFAULT_DESCRIPTION_TEMPLATE;
  await saveSettings({ draftDescriptionTemplate: DEFAULT_DESCRIPTION_TEMPLATE });
  flashSaved();
});

// ---------- API key ----------
/**
 * The key line says three different things, and the difference matters: no key yet, a key
 * that needs the passphrase for this browser session, or a key ready to use.
 */
/**
 * Der Schlüssel-Abschnitt — ein Weg je Lage.
 *
 * Vorher standen zwei Passwortfelder und zwei Knöpfe immer gleichzeitig da: wer einen Key
 * eintrug, sah „Entsperren" (tut nichts), wer nur entsperren wollte, sah ein leeres
 * Key-Feld und musste raten, ob es auszufüllen ist (nein). Welche Lage vorliegt und was
 * sie anbietet, entscheidet `lib/secret.js#describeKeyState`; hier wird nur ein- und
 * ausgeblendet.
 *
 * `forceSetup` ist der eine Fall, den der Zustand allein nicht hergibt: ein hinterlegter
 * Schlüssel soll durch einen anderen ersetzt werden.
 */
let forceSetup = false;

async function refreshKeyStatus(message = null, kind = '') {
  const [unlocked, stored] = await Promise.all([readCachedKey(), hasStoredKey()]);
  // `setup` ist der Wunsch des Nutzers und hängt an nichts sonst. Er war einmal
  // `forceSetup && !unlocked` — und damit im häufigsten Fall (Schlüssel liegt da UND ist
  // entsperrt) false, während `describeKeyState` gleichzeitig die gesperrte Ansicht
  // bekam: Titel „KI ist gesperrt", Key-Feld versteckt, Knopf „Entsperren". Einen
  // Schlüssel ersetzen ging dann nur nach einem Browser-Neustart.
  const setup = forceSetup;
  const view = describeKeyState({ stored: !!stored, unlocked: !!unlocked });

  $('keyTitle').textContent = setup ? 'Anderen Schlüssel hinterlegen' : view.title;
  $('keyHint').textContent = setup
    ? 'Der neue Schlüssel ersetzt den gespeicherten, sobald du hier speicherst.'
    : view.hint;

  const badge = $('keyBadge');
  badge.textContent = view.state === 'unlocked' ? 'entsperrt' : (view.state === 'locked' ? 'gesperrt' : '');
  badge.className = 'key-badge' + (view.kind ? ' is-' + view.kind : '');
  badge.hidden = !badge.textContent || setup;

  $('setApiKey').hidden = !(setup || view.needsKey);
  $('setPassphrase').hidden = !(setup || view.needsPassphrase);

  const action = setup ? 'Schlüssel speichern & entsperren' : view.action;
  $('keyAction').hidden = !action;
  if (action) $('keyAction').textContent = action;
  // Was der Knopf tut, hängt an der Lage — nicht daran, welchen von zweien man trifft.
  $('keyAction').dataset.mode = (setup || view.state === 'empty') ? 'store' : 'unlock';

  $('replaceKeyBtn').hidden = !(view.state !== 'empty' && !setup);
  $('clearKeyBtn').hidden = view.state === 'empty';

  setKeyStatus(message ?? '', kind);
}

function setKeyStatus(text, kind = '') {
  const el = $('keyStatus');
  el.className = 'key-status' + (kind ? ' ' + kind : '');
  el.textContent = text;
  el.hidden = !text;
}

/** Clear both secret fields once they've been used — nothing lingers in the DOM. */
function clearKeyInputs() {
  $('setApiKey').value = '';
  $('setPassphrase').value = '';
}

$('keyAction').addEventListener('click', async () => {
  const store = $('keyAction').dataset.mode === 'store';
  try {
    if (store) await storeKey($('setApiKey').value, $('setPassphrase').value);
    else await unlockKey($('setPassphrase').value);
    clearKeyInputs();
    forceSetup = false;
    await refreshKeyStatus(store ? 'Gespeichert und entsperrt.' : 'Entsperrt.', 'ok');
  } catch (e) {
    await refreshKeyStatus(e.message, 'error');
  }
});

$('replaceKeyBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  forceSetup = true;
  clearKeyInputs();
  await refreshKeyStatus();
  $('setApiKey').focus();
});

$('clearKeyBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  await clearKey();
  clearKeyInputs();
  forceSetup = false;
  await refreshKeyStatus('Schlüssel gelöscht.', '');
});

/** Der Satz unter dem scharf/Testlauf-Schalter — dieselbe Quelle wie das Schild im Studio. */
function renderDraftCreateHint() {
  const mode = publishModeNote({ settings: { draftCreateEnabled: $('setDraftCreate').checked } });
  $('draftCreateHint').textContent = mode.hint;
  $('draftCreateHint').className = 'setting-hint' + (mode.kind === 'live' ? ' is-live' : '');
}

// ---------- Init ----------
// Sichtbar, nicht nur im Log: nach „bitte neu laden" ist die Version die einzige Auskunft
// darüber, ob das auch geschehen ist.
$('version').textContent = 'v' + chrome.runtime.getManifest().version;
refreshLog();
renderHistory();
