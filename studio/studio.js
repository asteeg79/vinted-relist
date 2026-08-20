/**
 * Studio controller — intake, canvas, review.
 *
 * IT DECIDES NOTHING. Which fields are open, what the title is, which photo carries a
 * warning, whether publishing is released: all of it comes from `lib/draft-view.js`. This
 * file reads that model and writes `textContent`. The same rule the popup and the on-page
 * toast follow for gates (see lib/gates.js) — because this is the one zone the project
 * deliberately does not unit-test, so no decision may live here.
 *
 * The photos never leave this tab except as the small, already-cropped copy that goes to
 * the recognition call. Closing the tab loses them; the texts survive in the draft.
 */
import { getSettings } from '../lib/settings.js';
import { readCachedKey } from '../lib/secret.js';
import { analyse } from '../lib/ai.js';
import { draftView, FIELD_NEEDS_CONFIRMATION } from '../lib/draft-view.js';
import { loadPriceMemory, savePrice } from '../lib/price-memory.js';
import { HARD_MAX, SOFT_MAX } from '../lib/title.js';
import { createTaxonomy } from '../lib/taxonomy.js';
import { createVintedFetch } from '../lib/vinted-read.js';
import { lookupDraft, preselectCondition } from '../lib/lookup.js';
import { CONDITION_OPTIONS } from '../lib/settings.js';
import { ensureAuth } from '../lib/auth.js';
import { log } from '../lib/logger.js';

/**
 * Conservative until the spike (Schritt 0b) says what Vinted actually allows. ONE place,
 * so raising it later is a one-line change.
 */
const MAX_PHOTOS = 8;

/**
 * The domain the lookups run against. Fixed for now: the texts are German (§7.7) and the
 * price range is per marketplace, so mixing domains would silently mix markets.
 */
const DOMAIN = 'www.vinted.de';

const $ = id => document.getElementById(id);

const state = {
  /** { id, url, blob, base64, mediaType, touchesEdge, role, croppedOff } in display order */
  photos: [],
  analysis: null,
  settings: null,
  priceMemory: {},
  confirmations: {},
  overrides: {},
  // --- Stufe 2: what the lookup against Vinted produced -------------------------------
  resolved: {},
  conditions: [],
  requiredFields: [],
  lookupWarnings: [],
  picks: {},
  price: null,
  condition: null,
  busy: false
};

/** The read transport the spike unlocked: straight from this tab, no Vinted tab needed. */
const taxonomy = createTaxonomy({
  fetchJson: createVintedFetch({ domain: DOMAIN, ensureAuth })
});

// ---------- Intake ----------

$('maxPhotos').textContent = String(MAX_PHOTOS);

$('dropzone').addEventListener('click', () => $('filePicker').click());
$('dropzone').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('filePicker').click(); }
});
$('filePicker').addEventListener('change', e => {
  addFiles([...e.target.files]);
  e.target.value = ''; // so picking the same file twice still fires
});

for (const type of ['dragenter', 'dragover']) {
  $('dropzone').addEventListener(type, e => { e.preventDefault(); $('dropzone').classList.add('is-over'); });
}
for (const type of ['dragleave', 'drop']) {
  $('dropzone').addEventListener(type, () => $('dropzone').classList.remove('is-over'));
}
$('dropzone').addEventListener('drop', e => {
  e.preventDefault();
  addFiles([...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/')));
});

async function addFiles(files) {
  if (!files.length) return;
  const room = MAX_PHOTOS - state.photos.length;
  if (room <= 0) return setIntake(`Mehr als ${MAX_PHOTOS} Fotos gehen nicht.`);
  const accepted = files.slice(0, room);

  setIntake(`Verarbeite ${accepted.length} Foto(s)…`);
  // Loaded lazily: the canvas adapter touches the DOM, which the lib modules never do.
  const { prepare } = await import('./canvas.js');

  for (const file of accepted) {
    try {
      const prepared = await prepare(file);
      state.photos.push({ id: crypto.randomUUID(), name: file.name, role: '', croppedOff: false, ...prepared });
      log('studio_photo', {
        mode: prepared.mode,
        reason: prepared.reason,
        touchesEdge: prepared.touchesEdge,
        ...prepared.stats
      });
    } catch (e) {
      log('studio_photo_failed', { name: file.name, error: e.message });
      setIntake(`"${file.name}" konnte nicht gelesen werden: ${e.message}`);
    }
  }

  const skipped = files.length - accepted.length;
  setIntake(skipped ? `${skipped} Foto(s) übersprungen — Grenze sind ${MAX_PHOTOS}.` : '');
  render();
}

function setIntake(text) { $('intakeStatus').textContent = text; }

function removePhoto(id) {
  const index = state.photos.findIndex(p => p.id === id);
  if (index < 0) return;
  URL.revokeObjectURL(state.photos[index].url);
  state.photos.splice(index, 1);
  render();
}

// ---------- Analysis ----------

$('analyse').addEventListener('click', async () => {
  if (state.busy || !state.photos.length) return;

  const apiKey = await readCachedKey();
  if (!apiKey) {
    return setAnalyse('Kein API-Key entsperrt — in den Einstellungen des Popups eintragen bzw. entsperren.', 'error');
  }

  setBusy(true);
  setAnalyse('Erkenne Artikel…', 'working');
  try {
    state.analysis = await analyse(
      state.photos.map(p => ({ base64: p.base64, mediaType: p.mediaType })),
      { apiKey, settings: state.settings, log }
    );
    applySuggestedOrder();
    setAnalyse('Erkannt. Schlage Kategorie, Marke und Preis nach…', 'working');
    await runLookup();
    setAnalyse('Fertig. Jetzt prüfen und bestätigen.', 'ok');
  } catch (e) {
    log('studio_analyse_failed', { error: e.message, status: e.status });
    setAnalyse('Fehler: ' + e.message, 'error');
  } finally {
    setBusy(false);
    render();
  }
});

/**
 * Stufe 2: resolve the analysis against Vinted's own lists and fetch the price range.
 *
 * Read-only — no photo is uploaded, no lock is taken (§4.5). Runs again whenever
 * something it depends on moves: a chosen candidate, or a changed condition (the range
 * shifted from 4–9 € to 11–23 € for the same article in the spike).
 */
async function runLookup() {
  if (!state.analysis) return;
  try {
    const result = await lookupDraft({
      analysis: state.analysis,
      taxonomy,
      picks: state.picks,
      price: state.price,
      condition: state.condition
    });
    state.resolved = result.resolved;
    state.conditions = result.conditions;
    state.requiredFields = result.requiredFields;
    state.lookupWarnings = result.warnings;
    state.price = result.price;
    // Place the cursor on the configured default — once, and only if Vinted's list
    // actually contains it. Nothing pre-selected is better than something nobody chose.
    if (state.condition == null) {
      state.condition = preselectCondition(result.conditions, conditionLabel(state.settings?.draftConditionDefault));
    }
    log('studio_lookup', {
      catalog: result.resolved.catalog?.id ?? null,
      brand: result.resolved.brand?.id ?? null,
      size: result.resolved.size?.id ?? null,
      color: result.resolved.color?.id ?? null,
      price: result.price?.value ?? null,
      warnings: result.warnings.length
    });
  } catch (e) {
    // A failed lookup leaves the draft as it was — unresolved fields block publishing
    // anyway, so there is nothing to fall back to and nothing to invent.
    log('studio_lookup_failed', { error: e.message, status: e.status });
    state.lookupWarnings = ['Nachschlagen bei Vinted fehlgeschlagen: ' + e.message];
  }
}

function setAnalyse(text, kind = '') {
  $('analyseStatus').className = 'status' + (kind ? ' ' + kind : '');
  $('analyseStatus').textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  $('analyse').classList.toggle('is-loading', busy);
  $('analyse').disabled = busy || !state.photos.length;
}

/**
 * Adopt the model's photo order once, and remember each photo's role and crop verdict on
 * the photo itself. From then on the array order IS the order — dragging just moves an
 * entry, and the view keeps deriving cover and warnings from it.
 */
function applySuggestedOrder() {
  const entries = state.analysis?.photo_order || [];
  const byIndex = new Map(entries.map(e => [e.index, e]));
  const ordered = [];
  for (const entry of entries) {
    const photo = state.photos[entry.index];
    if (photo && !ordered.includes(photo)) ordered.push(photo);
  }
  for (const photo of state.photos) if (!ordered.includes(photo)) ordered.push(photo);

  for (const photo of ordered) {
    const entry = byIndex.get(state.photos.indexOf(photo));
    photo.role = entry?.role || '';
    photo.croppedOff = entry?.cropped_off === true;
    // The model looked at this one — from here its verdict outranks the crop heuristic.
    photo.judged = entry != null;
  }
  state.photos = ordered;
}

// ---------- Rendering ----------

/** The analysis as the view needs it: photo_order always mirrors the current order. */
function analysisForView() {
  if (!state.analysis) return null;
  return {
    ...state.analysis,
    photo_order: state.photos.map((photo, index) => ({
      index,
      role: photo.role,
      cropped_off: photo.croppedOff
    }))
  };
}

function currentView() {
  return draftView({
    analysis: analysisForView(),
    settings: state.settings || {},
    resolved: state.resolved,
    price: state.price,
    condition: state.condition,
    confirmations: state.confirmations,
    overrides: state.overrides,
    priceMemory: state.priceMemory,
    photos: state.photos.map(p => ({
      touchesEdge: p.touchesEdge,
      judged: p.judged === true,
      mode: p.mode,
      width: p.width,
      height: p.height
    }))
  });
}

function render() {
  const view = currentView();
  renderPhotos(view);
  renderFields(view);
  renderDerived(view);

  $('volatileHint').hidden = !state.photos.length;
  $('analyse').disabled = state.busy || !state.photos.length;
  $('copyAll').disabled = !state.analysis;
  $('downloadAll').disabled = !state.photos.length;

  // The model's own reservations and what the lookup against Vinted turned up — both are
  // things to know before publishing, neither blocks.
  const notes = [...state.lookupWarnings, ...(state.analysis?.notes || [])];
  $('notes').hidden = !notes.length;
  fill($('notesList'), notes, note => {
    const li = document.createElement('li');
    li.textContent = note;
    return li;
  });
}

/** Title, description and blockers — everything that changes while typing. */
function renderDerived(view = currentView()) {
  $('titleOut').textContent = view.title || '—';
  const bytes = new TextEncoder().encode(view.title).length;
  $('titleLen').textContent = `${view.title.length} Zeichen · ${bytes} Bytes (Optimum ${SOFT_MAX}, Limit ${HARD_MAX})`;
  $('titleLen').classList.toggle('over', bytes > HARD_MAX);

  if (document.activeElement !== $('descOut')) $('descOut').value = view.description;

  $('blockerBox').hidden = view.canPublish;
  fill($('blockerList'), view.blockers, blocker => {
    const li = document.createElement('li');
    li.textContent = blocker;
    return li;
  });

  // The studio only renders this decision — draft.js recomputes it before it writes
  // anything, so a bug here can make the button useless but never dangerous.
  const dryRun = state.settings?.draftCreateEnabled === false;
  $('publish').disabled = state.busy || !view.canPublish || !state.photos.length;
  $('publish').querySelector('.btn-label')?.replaceChildren(
    document.createTextNode(dryRun ? 'Trockenlauf starten' : 'Veröffentlichen')
  );
  $('publishHint').textContent = dryRun
    ? 'Trockenlauf: die Payload geht ins Log, es wird nichts eingestellt.'
    : 'Das Inserat wird wirklich eingestellt und ist danach öffentlich sichtbar.';
}

function renderPhotos(view) {
  fill($('photoList'), view.photos, entry => {
    const photo = state.photos[entry.index];
    const li = document.createElement('li');
    li.className = 'photo' + (entry.isCover ? ' is-cover' : '');
    li.draggable = true;
    li.dataset.id = photo.id;

    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = entry.role || photo.name;
    li.appendChild(img);

    if (entry.isCover) {
      const tag = document.createElement('span');
      tag.className = 'photo-tag';
      tag.textContent = 'Titelbild';
      li.appendChild(tag);
    }

    const remove = document.createElement('button');
    remove.className = 'photo-drop';
    remove.type = 'button';
    remove.title = 'Foto entfernen';
    remove.textContent = '×';
    remove.addEventListener('click', () => removePhoto(photo.id));
    li.appendChild(remove);

    const role = document.createElement('span');
    role.className = 'photo-role';
    role.textContent = entry.role || photo.name;
    li.appendChild(role);

    // What the pipeline actually did, per photo — otherwise "wurde das Bild überhaupt
    // bearbeitet, und stimmt die Auflösung?" cannot be answered by looking at it.
    const done = document.createElement('span');
    done.className = 'photo-done';
    const how = entry.mode === 'crop' ? 'zugeschnitten' : 'ergänzt';
    done.textContent = `${how} · ${entry.width}×${entry.height}`;
    li.appendChild(done);

    if (entry.warning) {
      const warn = document.createElement('span');
      warn.className = 'photo-warn ' + (entry.warningLevel || 'warn');
      warn.textContent = entry.warning;
      li.appendChild(warn);
    }

    bindDrag(li, photo.id);
    return li;
  });
}

/**
 * Reordering is a drag, not a confirmation: unlike the fields, a suboptimal cover picture
 * does no damage, it only costs clicks (KONZEPT §7.2).
 */
let dragging = null;

function bindDrag(li, id) {
  li.addEventListener('dragstart', e => {
    dragging = id;
    li.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  li.addEventListener('dragend', () => { dragging = null; li.classList.remove('is-dragging'); });
  li.addEventListener('dragover', e => e.preventDefault());
  li.addEventListener('drop', e => {
    e.preventDefault();
    if (!dragging || dragging === id) return;
    const from = state.photos.findIndex(p => p.id === dragging);
    const to = state.photos.findIndex(p => p.id === id);
    if (from < 0 || to < 0) return;
    state.photos.splice(to, 0, state.photos.splice(from, 1)[0]);
    render();
  });
}

function renderFields(view) {
  fill($('fieldList'), view.fields, field => {
    const li = document.createElement('li');
    li.className = 'field';

    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = field.label;
    li.appendChild(label);

    li.appendChild(field.key === 'condition' ? conditionInput(field) : valueInput(field));

    const chip = document.createElement('span');
    chip.className = 'field-state ' + field.state;
    chip.textContent = { ok: 'ok', needs_confirmation: 'bestätigen', missing: 'fehlt' }[field.state];
    li.appendChild(chip);

    if (field.state === FIELD_NEEDS_CONFIRMATION) {
      const confirm = document.createElement('button');
      confirm.className = 'field-confirm';
      confirm.type = 'button';
      confirm.textContent = 'Passt';
      confirm.addEventListener('click', () => {
        state.confirmations[field.key] = true;
        render();
      });
      li.appendChild(confirm);
    }

    if (field.note) {
      const note = document.createElement('span');
      note.className = 'field-note';
      note.textContent = field.note;
      li.appendChild(note);
    }

    if (field.key === 'price' && view.priceHint) li.appendChild(priceHint(view));
    if (field.candidates.length > 1) li.appendChild(candidateSelect(field));
    return li;
  });
}

function valueInput(field) {
  const input = document.createElement('input');
  input.className = 'field-value';
  input.type = 'text';
  if (field.key === 'price') {
    // Not type="number": on a German keyboard "24,50" is what gets typed, and a number
    // input silently discards it. draft-view.js parses both separators.
    input.inputMode = 'decimal';
  }
  input.value = field.value ?? '';
  input.placeholder = field.required ? 'erforderlich' : 'optional';
  input.setAttribute('aria-label', field.label);
  // Typing counts as a decision, so the state only settles when the field is left.
  input.addEventListener('input', () => {
    state.overrides[field.key] = input.value;
    renderDerived();
  });
  input.addEventListener('change', async () => {
    if (field.key === 'price') await rememberCurrentPrice();
    render();
  });
  return input;
}

/** The label the settings' symbolic default stands for ("very_good" → "Sehr gut"). */
function conditionLabel(value) {
  return CONDITION_OPTIONS.find(o => o.value === value)?.label ?? null;
}

/**
 * The condition select — filled from VINTED's list once the lookup has run, because those
 * carry the real `status_id`s. Before that there is nothing honest to offer.
 */
function conditionInput(field) {
  const select = document.createElement('select');
  select.className = 'field-value';
  select.setAttribute('aria-label', field.label);

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = state.conditions.length ? 'Zustand wählen' : 'kommt mit dem Nachschlagen';
  select.appendChild(empty);

  for (const { id, title } of state.conditions) {
    const option = document.createElement('option');
    option.value = String(id);
    option.textContent = title;
    select.appendChild(option);
  }
  select.disabled = state.conditions.length === 0;
  select.value = field.value != null ? String(field.value) : '';

  select.addEventListener('change', async () => {
    state.condition = select.value ? Number(select.value) : null;
    delete state.overrides.condition;
    // A changed condition is a new answer — it has to be confirmed again. And the price
    // range moves with it, so it is refetched (Entscheidung W3).
    delete state.confirmations.condition;
    await runLookup();
    render();
  });
  return select;
}

/**
 * Keep what was just entered, so the next comparable article can offer it. Only once an
 * analysis exists — before that there is no article to key the price on.
 */
async function rememberCurrentPrice() {
  if (!state.analysis) return;
  const view = currentView();
  const price = view.fields.find(f => f.key === 'price')?.value;
  if (price == null) return;
  state.priceMemory = await savePrice(view.priceKey, price);
}

/**
 * What this seller charged for something comparable, as one click. Deliberately a button
 * and not a pre-filled value: the price stays `missing` until someone decides on it.
 */
function priceHint(view) {
  const { price, count, match } = view.priceHint;
  const button = document.createElement('button');
  button.className = 'price-hint';
  button.type = 'button';
  const what = match === 'exact' ? 'zuletzt hierfür' : 'zuletzt für diese Marke';
  const often = count > 1 ? ` (${count}×)` : '';
  button.textContent = `${what}: ${price} €${often} — übernehmen`;
  button.addEventListener('click', () => {
    state.overrides.price = String(price);
    render();
  });
  return button;
}

/**
 * The choice between equally good candidates. Picking one records an ID and re-runs the
 * lookup — a chosen category changes the size set, the brand list and the price range,
 * so nothing downstream may keep the answer from before.
 */
function candidateSelect(field) {
  const select = document.createElement('select');
  select.className = 'field-candidates';
  select.setAttribute('aria-label', field.label + ' auswählen');

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = `${field.candidates.length} Treffer — auswählen`;
  select.appendChild(empty);

  for (const candidate of field.candidates) {
    const option = document.createElement('option');
    option.value = String(candidate.id ?? candidate.label);
    option.textContent = candidate.label;
    select.appendChild(option);
  }

  select.addEventListener('change', async () => {
    if (!select.value) return;
    const id = Number(select.value);
    if (Number.isFinite(id)) {
      // The pick still passes validatePick inside resolve.js — this only proposes it.
      state.picks[field.key] = id;
      await runLookup();
    } else {
      state.overrides[field.key] = select.value;
    }
    render();
  });
  return select;
}

/** Replace a list's children in one pass — the studio never patches, it re-renders. */
function fill(list, items, build) {
  list.replaceChildren(...items.map(build));
}

// ---------- Veröffentlichen ----------

/**
 * Show one gate from lib/gates.js and resolve true/false on its two buttons.
 *
 * The studio decides nothing about WHICH gates exist or what they say — that comes from
 * the service worker, exactly as it does for the relist gates in the popup.
 */
function askGate(gate) {
  return new Promise(resolve => {
    $('gateTitle').textContent = gate.title;
    $('gateText').textContent = gate.text || '';
    $('gateNote').textContent = gate.note || '';
    $('gateBox').hidden = false;
    const cleanup = result => {
      $('gateBox').hidden = true;
      $('gateProceed').onclick = null;
      $('gateCancel').onclick = null;
      resolve(result);
    };
    $('gateProceed').onclick = () => cleanup(true);
    $('gateCancel').onclick = () => cleanup(false);
  });
}

function setPublish(text, kind = '') {
  $('publishStatus').className = 'status' + (kind ? ' ' + kind : '');
  $('publishStatus').textContent = text;
}

$('publish').addEventListener('click', async () => {
  if (state.busy) return;

  // 1. Walk whatever gates the worker hands back. Only the first LIVE create has one.
  const gateReply = await chrome.runtime.sendMessage({ type: 'draft/gates' });
  for (const gate of gateReply?.gates || []) {
    setPublish('', '');
    if (!await askGate(gate)) return setPublish('Abgebrochen.', 'error');
    if (gate.remember) await chrome.runtime.sendMessage({ type: 'draft/confirmed' });
  }

  // 2. Hand the whole draft over. The worker recomputes the view and refuses a draft
  //    that is not ready — this side's `canPublish` is a rendering hint, not authority.
  state.busy = true;
  $('publish').classList.add('is-loading');
  $('publish').disabled = true;
  setPublish('Wird veröffentlicht…', 'working');
  try {
    const reply = await chrome.runtime.sendMessage({
      type: 'draft/publish',
      request: {
        domain: DOMAIN,
        draft: {
          analysis: analysisForView(),
          resolved: state.resolved,
          confirmations: state.confirmations,
          overrides: state.overrides,
          price: state.price,
          condition: state.condition,
          packageSizeId: state.packageSizeId ?? null,
          photos: state.photos.map(p => ({ touchesEdge: p.touchesEdge, judged: p.judged === true }))
        },
        photos: state.photos.map((p, i) => ({
          base64: p.base64, mediaType: p.mediaType, filename: `foto-${i + 1}.jpg`
        }))
      }
    });
    const message = reply?.message || { kind: 'error', text: 'Fehler: unbekannt' };
    setPublish(message.text, message.kind);
    if (reply?.newUrl) log('studio_published', { newId: reply.newId });
  } catch (e) {
    setPublish('Fehler: ' + e.message, 'error');
  } finally {
    state.busy = false;
    $('publish').classList.remove('is-loading');
    render();
  }
});

// ---------- Stufe 1 output: copy & download ----------

$('descOut').addEventListener('input', () => {
  state.overrides.description = $('descOut').value;
  renderDerived();
});
$('descOut').addEventListener('change', render);

$('copyAll').addEventListener('click', async () => {
  const view = currentView();
  const text = [
    view.title,
    '',
    view.description,
    '',
    ...view.fields.filter(f => f.value != null).map(f => `${f.label}: ${f.value}`)
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    flash($('copyAll'), 'Kopiert ✓', 'Titel & Text kopieren');
  } catch {
    flash($('copyAll'), 'Fehler beim Kopieren', 'Titel & Text kopieren');
  }
});

$('downloadAll').addEventListener('click', () => {
  const view = currentView();
  view.photos.forEach((entry, position) => {
    const photo = state.photos[entry.index];
    const link = document.createElement('a');
    link.href = photo.url;
    link.download = `${String(position + 1).padStart(2, '0')}-${(view.title || 'artikel').replace(/[^\w-]+/g, '_')}.jpg`;
    link.click();
  });
});

function flash(button, temporary, original) {
  button.textContent = temporary;
  setTimeout(() => { button.textContent = original; }, 1500);
}

// ---------- Init ----------

state.settings = await getSettings();
state.priceMemory = await loadPriceMemory();
render();
