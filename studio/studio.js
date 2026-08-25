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
import { getSettings, SETTINGS_KEY } from '../lib/settings.js';
import { readCachedKey } from '../lib/secret.js';
import { analyse } from '../lib/ai.js';
import { draftView, conflictedFields, FIELD_NEEDS_CONFIRMATION } from '../lib/draft-view.js';
import { modelBoxVerdict } from '../lib/crop.js';
import { loadPriceMemory, savePrice } from '../lib/price-memory.js';
import { publishModeNote, publishedNote, resetGateFor } from '../lib/gates.js';
import { HARD_MAX, SOFT_MAX } from '../lib/title.js';
import { createTaxonomy } from '../lib/taxonomy.js';
import { createVintedFetch } from '../lib/vinted-read.js';
import { lookupDraft } from '../lib/lookup.js';
import { ensureAuth } from '../lib/auth.js';
import { log, LOG_KEY, clearLog } from '../lib/logger.js';
import { arrayBufferToBase64 } from '../lib/util.js';

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
  /**
   * In display order. ZWEI KOPIEN JE FOTO, und die Unterscheidung ist tragend:
   *   blob        das Inseratsbild, 1080×1350, zugeschnitten — DAS wird hochgeladen
   *   modelBase64 das ganze Foto, ungeschnitten — DAS sieht die Erkennung
   * { id, url, blob, modelBase64, mediaType, touchesEdge, role, croppedOff }
   */
  photos: [],
  analysis: null,
  settings: null,
  priceMemory: {},
  confirmations: {},
  overrides: {},
  // --- Stufe 2: what the lookup against Vinted produced -------------------------------
  resolved: {},
  conditions: [],
  /** { source: 'ai' | 'default' | 'user' | null, evidence } — where state.condition came from */
  conditionMeta: {},
  lookupWarnings: [],
  /** Warum keine Preisspanne kam — der Satz dazu steht in lib/draft-view.js. */
  priceReason: null,
  picks: {},
  price: null,
  condition: null,
  /** Die id des Inserats, das aus diesem Draft entstanden ist — danach ist er verbraucht. */
  publishedId: null,
  busy: false
};

/**
 * Alles vergessen, was zu EINEM Artikel gehört — für den nächsten.
 *
 * WAS BLEIBT UND WARUM. Die Einstellungen, das Preisgedächtnis und der Taxonomie-Cache
 * (Kategoriebaum, Farben, Größen je Kategorie) gehören nicht zum Artikel: sie gelten für
 * jeden. Sie stehen zudem in `chrome.storage`, überleben also ohnehin jedes Neuladen der
 * Seite — sie hier zu löschen hieße, den 486 KB großen Baum beim nächsten Artikel erneut
 * zu holen.
 *
 * WAS GEHT, geht vollständig: die Fotos samt ihrer Object-URLs (die der Browser sonst bis
 * zum Schließen des Tabs festhält, zwei je Foto), die Erkennung, jede aufgelöste ID, jede
 * Bestätigung, jedes getippte Wort, der Preis und die eingestellte Inseratsnummer. Was
 * davon stehen bliebe, würde am nächsten Artikel als seine eigene Angabe erscheinen — und
 * eine bestätigte Marke vom Vorgänger ist genau die Sorte Fehler, die niemand bemerkt.
 */
function resetDraft() {
  for (const photo of state.photos) {
    URL.revokeObjectURL(photo.url);
    URL.revokeObjectURL(photo.modelUrl);
  }
  Object.assign(state, {
    photos: [],
    analysis: null,
    confirmations: {},
    overrides: {},
    resolved: {},
    conditions: [],
    conditionMeta: {},
    lookupWarnings: [],
    priceReason: null,
    picks: {},
    price: null,
    condition: null,
    publishedId: null
  });
  $('descOut').value = '';
  setIntake('');
  setAnalyse('');
  setPublish('');
  log('studio_reset', {});
  render();
}

/** The read transport the spike unlocked: straight from this tab, no Vinted tab needed. */
const taxonomy = createTaxonomy({
  fetchJson: createVintedFetch({ domain: DOMAIN, ensureAuth })
});

// ---------- Intake ----------

$('maxPhotos').textContent = String(MAX_PHOTOS);
$('version').textContent = 'v' + chrome.runtime.getManifest().version;

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
  // WÄHREND DER ERKENNUNG NICHT. Das Modell antwortet mit Foto-INDIZES; kommt zwischen
  // Frage und Antwort ein Foto dazu oder weg, bekommt das falsche Foto die Rolle, das
  // `cropped_off` und die Artikelbox eines anderen — und wird danach auf einen Bereich
  // zugeschnitten, den nie jemand für dieses Foto geprüft hat.
  if (state.busy) return setIntake('Erkennung läuft — bitte warten.');
  const room = MAX_PHOTOS - state.photos.length;
  if (room <= 0) return setIntake(`Mehr als ${MAX_PHOTOS} Fotos gehen nicht.`);
  const accepted = files.slice(0, room);

  setIntake(`Verarbeite ${accepted.length} Foto(s)…`);
  // Loaded lazily: the canvas adapter touches the DOM, which the lib modules never do.
  const { prepare } = await import('./canvas.js');
  const failed = [];

  for (const file of accepted) {
    try {
      const prepared = await prepare(file);
      // The File is kept, not just the result: the second crop pass redraws from the
      // original, and re-cropping a crop would only compound the loss.
      state.photos.push({ id: crypto.randomUUID(), name: file.name, file, role: '', croppedOff: false, ...prepared });
      log('studio_photo', {
        // Without the name the three lines cannot be matched to the three files, and
        // "which photo was the label?" stays unanswerable.
        name: file.name,
        mode: prepared.mode,
        reason: prepared.reason,
        touchesEdge: prepared.touchesEdge,
        listing: `${prepared.width}×${prepared.height}`,
        // What the recognition really gets to look at: the whole photo, uncropped. If this
        // ever stops matching the source's aspect ratio, something is cropping before the
        // model sees it — which is exactly the bug this arrangement exists to prevent.
        model: `${prepared.modelWidth}×${prepared.modelHeight}`,
        modelKb: Math.round(prepared.modelBytes / 1024),
        ...prepared.stats
      });
    } catch (e) {
      log('studio_photo_failed', { name: file.name, error: e.message });
      failed.push(file.name);
    }
  }

  // Neue Fotos sind ein neuer Artikel: die Sperre nach einem eingestellten Inserat gilt
  // für den Draft, aus dem es entstanden ist, nicht für den nächsten.
  state.publishedId = null;

  // Die Meldung am Ende trägt BEIDES. Vorher schrieb der catch-Zweig seinen Satz hin, und
  // zwei Zeilen später überschrieb ihn diese Stelle mit '' — wer eine HEIC-Datei mit
  // hineinzog, sah zwei Fotos statt drei und nirgends eine Erklärung.
  const skipped = files.length - accepted.length;
  const parts = [];
  if (skipped) parts.push(`${skipped} Foto(s) übersprungen — Grenze sind ${MAX_PHOTOS}.`);
  if (failed.length) parts.push(`Nicht lesbar: ${failed.join(', ')}.`);
  setIntake(parts.join(' '));
  render();
}

function setIntake(text) { $('intakeStatus').textContent = text; }

function removePhoto(id) {
  // Siehe `addFiles`: die Antwort des Modells zeigt auf Positionen in dieser Liste.
  if (state.busy) return setIntake('Erkennung läuft — bitte warten.');
  const index = state.photos.findIndex(p => p.id === id);
  if (index < 0) return;
  URL.revokeObjectURL(state.photos[index].url);
  URL.revokeObjectURL(state.photos[index].modelUrl);
  state.photos.splice(index, 1);
  render();
}

// ---------- Analysis ----------

$('analyse').addEventListener('click', async () => {
  if (state.busy || !state.photos.length) return;

  const apiKey = await readCachedKey();
  if (!apiKey) {
    return setAnalyse('KI gesperrt — im Popup unter Einstellungen › KI-Zugang entsperren.', 'error');
  }

  setBusy(true);
  setAnalyse('Erkenne Artikel…', 'working');
  try {
    state.analysis = await analyse(
      // Die Modellkopie: das ganze Foto, ungeschnitten. Das Inseratsbild wäre hier falsch
      // — der Zuschnitt ist die Antwort auf die Erkennung, nicht ihre Eingabe.
      state.photos.map(p => ({ base64: p.modelBase64, mediaType: p.mediaType })),
      { apiKey, settings: state.settings, log }
    );
    applySuggestedOrder();
    setAnalyse('Erkannt. Schneide nach, was nicht zum Artikel gehört…', 'working');
    await applySuggestedCrops();
    render(); // the new crops before the lookup's wait, not after it
    setAnalyse('Schlage Kategorie, Marke und Preis nach…', 'working');
    const failed = await runLookup();
    setAnalyse(failed || 'Fertig. Jetzt prüfen und bestätigen.', failed ? 'error' : 'ok');
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
 *
 * GIBT DIE FEHLERMELDUNG ZURÜCK, sonst null. Jeder Aufrufer muss sie anzeigen: eine
 * gescheiterte Auflösung ändert an den Feldern nichts, und ohne ein Wort auf dem Bildschirm
 * sieht das aus, als hätte der Klick nichts ausgelöst. Genau so wurde am 2026-08-21 eine
 * abgelaufene Sitzung erlebt — dreimal eine Kategorie gewählt, dreimal 401, dreimal keine
 * sichtbare Reaktion. Der Satz stammt aus `lib/`; hier wird er nur hingeschrieben.
 */
async function runLookup() {
  if (!state.analysis) return null;
  try {
    const result = await lookupDraft({
      analysis: state.analysis,
      taxonomy,
      picks: state.picks,
      price: state.price,
      condition: state.condition,
      // Mitgeben, sonst gilt jede behaltene Stufe als selbst gewählt und der Hinweis,
      // warum die Erkennung sie vorgeschlagen hat, verschwindet beim nächsten Nachschlagen.
      conditionMeta: state.conditionMeta,
      // Ebenso: ein offener Widerspruch der Gegenprobe darf sich nicht wegauflösen lassen.
      previous: state.resolved,
      settings: state.settings || {},
      // What the user typed wins over what the model called the article.
      labels: { category: state.overrides.category, size: state.overrides.size }
    });
    state.resolved = result.resolved;
    state.conditions = result.conditions;
    state.lookupWarnings = result.warnings;
    state.price = result.price;
    state.priceReason = result.priceReason;
    // The cursor position for the condition, decided in lib/condition.js: the model's
    // reading when it was sure enough, otherwise the configured default. Either way it
    // still has to be confirmed.
    state.condition = result.condition.id;
    // Vollständig übernehmen: `value` ist das Symbol, das `chooseCondition` gewählt hat,
    // und ohne es verliert eine behaltene Stufe beim nächsten Nachschlagen die Hälfte
    // ihrer Herkunft — dieselbe Lücke wie zuvor bei `evidence`.
    state.conditionMeta = {
      source: result.condition.source,
      value: result.condition.value,
      evidence: result.condition.evidence
    };
    log('studio_lookup', {
      catalog: result.resolved.catalog?.id ?? null,
      brand: result.resolved.brand?.id ?? null,
      size: result.resolved.size?.id ?? null,
      color: result.resolved.color?.id ?? null,
      price: result.price?.value ?? null,
      priceReason: result.priceReason,
      // Enough to tell the two size failures apart without another round trip: did the
      // model read nothing, or did Vinted's set not contain what it read?
      sizeRead: state.analysis?.size_label ?? null,
      sizeSource: state.analysis?.size_source ?? null,
      sizeOptions: (result.resolved.size?.candidates?.length ?? 0) || null,
      conditionCount: result.conditions.length,
      condition: result.condition.id,
      conditionFrom: result.condition.source,
      warnings: result.warnings.length
    });
    return null;
  } catch (e) {
    // A failed lookup leaves the draft as it was — unresolved fields block publishing
    // anyway, so there is nothing to fall back to and nothing to invent.
    log('studio_lookup_failed', { error: e.message, status: e.status });
    state.lookupWarnings = [e.message];
    return e.message;
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
    photo.distractions = entry?.distractions || null;
    photo.articleBox = entry?.article_box || null;
    // The model looked at this one — from here its verdict outranks the crop heuristic.
    photo.judged = entry != null;
  }
  state.photos = ordered;
}

/**
 * Second crop pass: redraw the photos for which the model drew an article box.
 *
 * This is the answer to the photographer's shoes at the bottom edge. `objectBox` removes
 * background and keeps everything else, and shoes are not background — no threshold fixes
 * that, because from the pixels' point of view the shoes are a perfectly good object. The
 * model is the only party that knows which object is the article.
 *
 * Each photo is redrawn from its ORIGINAL file, never from the already-cropped copy: two
 * crops in a row would compound the loss on exactly the pixels the recognition needs.
 * `boxFromModel` refuses an implausible box, and then the first pass simply stands.
 */
async function applySuggestedCrops() {
  const pending = state.photos.filter(p => p.articleBox && p.file && p.modelFrame);
  if (!pending.length) return;

  const { prepare } = await import('./canvas.js');
  for (const photo of pending) {
    try {
      // ERST FRAGEN, DANN ZEICHNEN. Das Urteil ist reine Arithmetik über Zahlen, die hier
      // schon liegen; `prepare` dagegen dekodiert das volle Foto und kodiert ein JPEG. Die
      // beiden häufigsten Absagen — „füllt ohnehin das Bild" und „müsste zu stark
      // hochgerechnet werden" — kosteten damit je einen kompletten Durchlauf für nichts,
      // und seit der Prompt für JEDES Foto eine Artikelbox verlangt, für jedes Foto.
      //
      // DIE MASSE DES ORIGINALS, nicht die des Rahmens: `modelBoxVerdict` klemmt gegen das
      // Bild und prüft daran auch die Fläche und die Hochrechnung. Hier stand einmal
      // `photo.modelFrame.w/h` — und das stimmt nur, solange die Modellkopie das ganze Foto
      // ist. Genau diese Annahme verbietet `canvas.js` an der Stelle, die `modelFrame`
      // liefert.
      const verdict = modelBoxVerdict(photo.articleBox, photo.modelFrame, photo.sourceWidth, photo.sourceHeight);
      if (!verdict.box) {
        // 'full_frame' is the normal "nothing to trim here" and stays quiet as such; the
        // other reasons mean the model proposed something unusable, and a model that keeps
        // doing that is a prompt problem which silence would hide.
        log('studio_recrop_skipped', { name: photo.name, reason: verdict.reason, box: photo.articleBox });
        continue;
      }

      // DIE FERTIGE BOX, nicht die Zutaten dafür. `prepare` rechnete das Urteil sonst ein
      // zweites Mal aus — zwei Rechnungen, die übereinstimmen MÜSSEN, samt einem Zweig hier,
      // der den Fall abfing, dass sie es nicht tun. Wer entscheidet, entscheidet einmal:
      // hier fällt das Urteil, dort wird gezeichnet.
      const redrawn = await prepare(photo.file, { box: verdict.box, boxReason: verdict.reason });

      // NUR die Inseratskopie wird frei — die Modellkopie liefert der zweite Durchgang gar
      // nicht mehr, weil sie Byte für Byte dieselbe wäre. `Object.assign` lässt sie stehen.
      URL.revokeObjectURL(photo.url);
      Object.assign(photo, redrawn);
      log('studio_recrop', {
        name: photo.name,
        distractions: photo.distractions,
        // Die Box gehört ins Log, auch wenn sie angenommen wurde. Am 2026-08-21 stand im
        // ersten echten Inserat unten immer noch der Fotograf im Bild, während das Log
        // „distractions: Füße des Fotografen unten" und „mode: crop" meldete — beides
        // richtig, und trotzdem nicht nachvollziehbar, weil niemand sah, WELCHE Box
        // benutzt wurde. Ohne die Zahlen ist nicht zu unterscheiden, ob das Modell zu
        // großzügig gezeichnet oder der 4:5-Rahmen den Rand wieder hereingeholt hat.
        box: photo.articleBox,
        mode: redrawn.mode,
        listing: `${redrawn.width}×${redrawn.height}`,
        // Aus dem ersten Durchgang — der zweite zeichnet sie nicht neu.
        model: `${photo.modelWidth}×${photo.modelHeight}`
      });
    } catch (e) {
      // A failed redraw leaves the first pass in place — a photo, just with more background.
      log('studio_recrop_failed', { name: photo.name, error: e.message });
    }
  }
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
    conditions: state.conditions,
    conditionMeta: state.conditionMeta,
    confirmations: state.confirmations,
    overrides: state.overrides,
    priceMemory: state.priceMemory,
    priceReason: state.priceReason,
    publishedId: state.publishedId,
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
  // DEN FOKUS RETTEN. `renderFields` ersetzt jedes Eingabefeld; `change` feuert beim
  // Verlassen, also genau dann, wenn der Browser das NÄCHSTE Feld schon fokussiert hat.
  // Ohne das hier fiel der Fokus bei jedem Tab-Sprung auf <body>, und man musste jedes
  // Feld mit der Maus neu greifen. Gemerkt wird der Feldschlüssel, nicht das Element —
  // das alte ist nach dem Neuaufbau ohnehin weg.
  const focused = document.activeElement?.dataset?.field || null;
  const caret = typeof document.activeElement?.selectionStart === 'number'
    ? document.activeElement.selectionStart
    : null;

  const view = currentView();
  renderPhotos(view);
  renderFields(view);
  renderDerived(view);

  if (focused) {
    const next = $('fieldList').querySelector(`[data-field="${focused}"]`);
    if (next) {
      next.focus();
      if (caret != null && typeof next.setSelectionRange === 'function') {
        next.setSelectionRange(caret, caret);
      }
    }
  }

  // Das Schild oben rechts: entsteht hier ein echtes Inserat, oder nicht? Mehr wird dort
  // nicht beantwortet — die Stufen aus dem Konzept waren eine Entwicklungslandkarte und
  // keine Auskunft über den nächsten Klick.
  const mode = publishModeNote({ settings: state.settings || {} });
  $('stageNote').textContent = mode.text;
  $('stageNote').className = 'stage-note is-' + mode.kind;
  $('publish').classList.toggle('is-live', mode.kind === 'live');

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

  // AN DER LISTE, NICHT AM KNOPF. Hier stand `hidden = view.canPublish` — solange
  // „veröffentlichbar" und „nichts offen" dasselbe waren, ging das gut. Seit ein fertig
  // eingestellter Draft ein eigener Grund für `canPublish: false` ist, laufen die beiden
  // auseinander: nach dem Einstellen stand „Noch offen" als leerer Kasten da. Die
  // Überschrift beantwortet „was fehlt noch" — ohne Eintrag gibt es nichts zu beantworten.
  $('blockerBox').hidden = view.blockers.length === 0;
  fill($('blockerList'), view.blockers, blocker => {
    const li = document.createElement('li');
    li.textContent = blocker;
    return li;
  });

  // The studio only renders this decision — draft.js recomputes it before it writes
  // anything, so a bug here can make the button useless but never dangerous. Schild,
  // Knopf und Hinweis stammen aus derselben Quelle, damit sie nicht auseinanderlaufen.
  const mode = publishModeNote({ settings: state.settings || {} });
  $('publish').disabled = state.busy || !view.canPublish || !state.photos.length;
  $('publish').querySelector('.btn-label')?.replaceChildren(document.createTextNode(mode.button));

  // Ist der Draft fertig, steht das statt des Modus-Hinweises da — der erklärt, was ein
  // Klick bewirken WÜRDE, und das ist hier nicht mehr die Frage.
  const done = publishedNote({ publishedId: view.publishedId });
  $('publishHint').textContent = done ? done.text : mode.hint;
  $('publishHint').className = done ? 'hint is-done' : 'hint';

  // Nach dem Einstellen ist Leeren der nächste Schritt, nicht mehr eine Nebentür.
  $('reset').disabled = state.busy;
  $('reset').className = view.done ? 'btn-primary' : 'btn-secondary';
  $('reset').textContent = view.done ? 'Nächster Artikel' : 'Studio leeren — nächster Artikel';
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

    // Say when the second pass actually moved the frame, and what it removed. Otherwise
    // "hat die KI die Füße rausgeschnitten?" is only answerable by comparing two crops
    // from memory.
    if (photo.boxSource === 'model') {
      const recrop = document.createElement('span');
      recrop.className = 'photo-recrop';
      recrop.textContent = photo.distractions
        ? `nachgeschnitten · ${photo.distractions} entfernt`
        : 'nachgeschnitten durch die Erkennung';
      li.appendChild(recrop);
    }

    // The exact JPEG the recognition receives. When a size stays unread, this answers the
    // only question that matters first — was the label legible at all? — by looking,
    // rather than by another round of prompt guesswork.
    if (photo.modelUrl) {
      const seen = document.createElement('a');
      seen.className = 'photo-seen';
      seen.href = photo.modelUrl;
      seen.target = '_blank';
      seen.rel = 'noopener';
      seen.textContent = `was die KI sieht · ungeschnitten · ${photo.modelWidth}×${photo.modelHeight}`;
      li.appendChild(seen);
    }

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
    // Umsortieren während der Erkennung verschiebt genau die Positionen, auf die sich die
    // Antwort des Modells gleich bezieht — siehe `addFiles`.
    if (state.busy || !dragging || dragging === id) return;
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

    // Ein Feld mit fester Auswahl bekommt ein Auswahlfeld — welche Felder das sind, steht
    // an ihnen (`options`) und nicht hier. Der Zustand behält sein eigenes: eine Änderung
    // dort setzt zusätzlich die Bestätigung zurück und holt die Preisspanne neu.
    li.appendChild(
      field.key === 'condition' ? conditionInput(field)
        : field.options.length ? optionsInput(field)
          : valueInput(field)
    );

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

    if (field.hint) {
      const hint = document.createElement('span');
      hint.className = 'field-hint';
      hint.textContent = field.hint;
      li.appendChild(hint);
    }

    if (field.key === 'price' && view.priceHint) li.appendChild(priceHint(view));
    if (field.candidates.length > 1) li.appendChild(candidateSelect(field));
    return li;
  });
}

/**
 * Ein getipptes Wort nachschlagen, und den Fund festnageln.
 *
 * Der zweite Durchgang ist kein Umweg: er macht aus dem Treffer eine Wahl (`picks`) und
 * wirft den getippten Text weg, damit im Feld Vinteds eigene Schreibweise steht und das
 * nächste Nachschlagen nicht wieder vom Wort des Modells ausgeht.
 *
 * Welche Felder das betrifft, wo ihre Auflösung liegt und wie sie heißen, steht am Feld —
 * `draft-view.js` führt diese Tabellen ohnehin. Hier standen sie ein zweites Mal, und die
 * Beschriftung war dabei falsch: bei Medien heißt das Feld „Titel", die Statuszeile sagte
 * „Schlage die Kategorie nach…".
 *
 * DIE MELDUNGEN SETZEN DIE BESCHRIFTUNG IN ANFÜHRUNGSZEICHEN, statt sie in einen Satz
 * einzubauen. Der erste Anlauf tauschte nur die Tabelle gegen `field.label` und behielt den
 * Satzbau — heraus kam „Schlage die Titel nach…". Ein eingebauter Artikel ist dieselbe
 * Annahme wie eine eingebaute Tabelle, nur kleiner: er gilt für ein Wort, das von woanders
 * kommt und sich ändern darf.
 */
async function retypeField(field) {
  const key = field.key;
  const resolvedKey = field.resolvedAs;
  const label = field.label;

  delete state.picks[key]; // das getippte Wort ersetzt eine frühere Wahl
  // OHNE ARTIKEL, und das ist kein Stilwunsch. Die Beschriftung kommt aus `draft-view.js`
  // und ist je nach Warengruppe eine andere: bei Medien heißt das Feld „Titel", nicht
  // „Kategorie". „Schlage die Titel nach…" war die Folge eines eingebauten „die" — dieselbe
  // Sorte Fehler wie die hartkodierte Tabelle davor, nur eine Ebene kleiner. In
  // Anführungszeichen gesetzt passt jede Beschriftung.
  setAnalyse(`„${label}" wird nachgeschlagen…`, 'working');

  let failed = await runLookup();
  const resolution = failed ? null : state.resolved[resolvedKey];
  const found = resolution?.id ?? null;
  if (found != null) {
    state.picks[key] = found;
    delete state.overrides[key];
    failed = await runLookup();
  }

  // Ein 401 hat Vorrang vor jedem Befund — „nicht gefunden" wäre dann schlicht gelogen.
  if (failed) return setAnalyse(failed, 'error');
  if (found != null) return setAnalyse(`${label}: ${state.resolved[resolvedKey].label}`, 'ok');

  // Eine Auswahl ist auch ein Befund, und beim Navigieren durch den Baum der Normalfall:
  // „Kinder" ist keine Kategorie, sondern ein Bereich. „Keine passende Kategorie gefunden"
  // wäre hier eine Absage an einen Schritt, der gerade funktioniert hat.
  const options = resolution?.candidates?.length ?? 0;
  setAnalyse(
    options
      ? `${label}: ${options} zur Auswahl — unten weitergehen`
      : `Nichts gefunden für „${label}".`,
    options ? 'ok' : 'error'
  );
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
  input.dataset.field = field.key;
  // Typing counts as a decision, so the state only settles when the field is left.
  input.addEventListener('input', () => {
    state.overrides[field.key] = input.value;
    renderDerived();
  });
  input.addEventListener('change', async () => {
    if (field.key === 'price') await rememberCurrentPrice();
    // A retyped category is a new question for Vinted, not just new text: the size set,
    // the brand list and the price range all hang off it. Dasselbe gilt für die Größe —
    // ein getipptes „152" war bis 0.98.0 dekorativ, und der Hinweis „anderen Begriff
    // eintippen" schickte den Nutzer damit im Kreis.
    if (field.relookupOnType) await retypeField(field);
    render();
  });
  return input;
}

/**
 * Ein Feld, dessen Antworten feststehen — die Sprache eines Buchs ist die erste.
 *
 * Die Liste kommt vom Feld, nicht von hier: `draft-view.js` führt sie ohnehin, und eine
 * zweite Fassung im Studio wäre genau die Kopie, die beim nächsten Eintrag stehenbliebe.
 *
 * Steht der aktuelle Wert NICHT in der Liste, wird er nicht heimlich zu einer gültigen
 * Antwort gemacht. Das Auswahlfeld steht dann leer und sagt im Platzhalter, was da war —
 * die Begründung steht als Notiz am Feld.
 */
function optionsInput(field) {
  const known = field.options.some(o => o.value === field.value);
  return buildSelect({
    className: 'field-value',
    ariaLabel: field.label,
    fieldKey: field.key,
    placeholder: field.value && !known ? `„${field.value}" — bitte wählen` : `${field.label} wählen`,
    options: field.options,
    value: field.value,
    onChange: e => {
      if (e.currentTarget.value) state.overrides[field.key] = e.currentTarget.value;
      else delete state.overrides[field.key];
      render();
    }
  });
}

/**
 * Das Gerüst eines Auswahlfeldes — dreimal gebraucht, einmal geschrieben.
 *
 * Element anlegen, Beschriftung setzen, einen leeren Eintrag als Platzhalter voranstellen,
 * die Liste einhängen, die Vorauswahl setzen, auf `change` hören: das war dreimal dasselbe,
 * mit je einer Abweichung, die im Rauschen unterging. Was wirklich verschieden ist, steht
 * jetzt in den Aufrufen — die Zustandsliste bringt Erklärungen mit, die Kandidatenliste
 * kennt keine Vorauswahl, das Sprachfeld schreibt seine Antwort in die Overrides.
 *
 * DIE VORAUSWAHL GILT NUR, WENN SIE IN DER LISTE STEHT. Ein Wert, den es dort nicht gibt,
 * würde vom Browser stillschweigend verworfen und das Feld sähe aus wie „nichts gewählt" —
 * hier ist es das dann auch, und der Platzhalter sagt, was stattdessen da war.
 */
function buildSelect({ className, ariaLabel, fieldKey, placeholder, options, value = '', disabled = false, onChange }) {
  const select = document.createElement('select');
  select.className = className;
  select.setAttribute('aria-label', ariaLabel);
  if (fieldKey) select.dataset.field = fieldKey;

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = placeholder;
  select.appendChild(empty);

  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    if (option.title) el.title = option.title;
    select.appendChild(el);
  }

  select.disabled = disabled;
  select.value = options.some(o => o.value === value) ? value : '';
  select.addEventListener('change', onChange);
  return select;
}

/**
 * The condition select — filled from VINTED's list once the lookup has run, because those
 * carry the real `status_id`s. Before that there is nothing honest to offer.
 *
 * Each option keeps Vinted's own explanation as its tooltip, so "Sehr gut" is judged by
 * their yardstick and not by the seller's hope.
 */
function conditionInput(field) {
  const select = buildSelect({
    className: 'field-value',
    ariaLabel: field.label,
    fieldKey: field.key,
    placeholder: state.conditions.length ? 'Zustand wählen' : 'kommt mit dem Nachschlagen',
    options: state.conditions.map(c => ({ value: String(c.id), label: c.title, title: c.explanation })),
    value: field.id != null ? String(field.id) : '',
    disabled: state.conditions.length === 0,
    onChange: async e => {
      state.condition = e.currentTarget.value ? Number(e.currentTarget.value) : null;
      state.conditionMeta = { source: 'user', value: null, evidence: null };
      // A changed condition is a new answer — it has to be confirmed again. And the price
      // range moves with it, so it is refetched (Entscheidung W3).
      delete state.confirmations.condition;
      const failed = await runLookup();
      if (failed) setAnalyse(failed, 'error');
      render();
    }
  });
  // Vinteds Maßstab auch für die aktuelle Wahl, nicht nur beim Aufklappen.
  select.title = state.conditions.find(c => String(c.id) === select.value)?.explanation || '';
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
  return buildSelect({
    className: 'field-candidates',
    ariaLabel: field.label + ' auswählen',
    // Ein Schritt (`path`, keine id) ist kein Ziel, sondern die nächste Eingabe — siehe
    // `browseCatalogs`. Welche Sorte Liste das ist, entscheidet `draft-view.js`.
    placeholder: field.candidateKind === 'steps'
      ? `${field.candidates.length} Bereiche — weiter eingrenzen`
      : `${field.candidates.length} Treffer — auswählen`,
    // Ein Schritt trägt seinen Pfad, ein Treffer seine id. Beides landet unten in
    // verschiedenen Zweigen, und die Unterscheidung ist genau die zwischen „weiter" und
    // „das ist es".
    options: field.candidates.map(c => ({
      value: c.id != null ? String(c.id) : (c.path ?? c.label),
      label: c.label
    })),
    // KEINE Vorauswahl: die Liste steht da, weil noch nichts entschieden ist.
    onChange: async e => {
      const picked = e.currentTarget.value;
      if (!picked) return;
      const id = Number(picked);
      if (Number.isFinite(id) && field.candidates.some(c => String(c.id) === picked)) {
        // The pick still passes validatePick inside resolve.js — this only proposes it.
        state.picks[field.key] = id;
        // UND DAS GETIPPTE WORT IST DAMIT ERLEDIGT. Ohne diese Zeile blieb es stehen und
        // gewann im Titel: `values` liest `overrides` VOR der Auflösung. Live zu sehen an
        // einem eingestellten Inserat — Titel „Under Armour Kinder Jungs Hose 146 Schwarz",
        // während es unter „Herren > Kleidung > Hosen > Jogging-Hosen" mit Größe „M" lag.
        // Der Titel behauptete etwas anderes als die Angaben darunter, und beides stand
        // öffentlich. Wer aus der Liste wählt, hat seinen Suchbegriff ersetzt, nicht ergänzt.
        delete state.overrides[field.key];
        setAnalyse(`„${field.label}" wird nachgeschlagen…`, 'working');
        const failed = await runLookup();
        const chosen = field.candidates.find(c => c.id === id)?.label;
        setAnalyse(failed || `${field.label}: ${chosen ?? 'übernommen'}`, failed ? 'error' : 'ok');
      } else {
        // Der gewählte Pfad wird zum getippten Wort — dieselbe Filterung, eine Ebene tiefer.
        state.overrides[field.key] = picked;
        if (field.relookupOnType) await retypeField(field);
      }
      render();
    }
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

  // AB HIER BESETZT. Vorher stand das erst nach dem Gate-Umlauf, und solange der Dialog
  // offen war, blieb der Knopf klickbar: ein zweiter Klick hängte `askGate` neu auf, und
  // das erste Versprechen wartete bis zum Tab-Ende auf einen Klick, der nie kam.
  state.busy = true;
  $('publish').classList.add('is-loading');
  $('publish').disabled = true;

  try {
    // 1. Walk whatever gates the worker hands back. Only the first LIVE create has one.
    //
    // IM ZWEIFEL NICHT VERÖFFENTLICHEN. Dieser Aufruf stand außerhalb von try/catch und
    // fiel nach außen offen aus: schlief der Worker, verpuffte der Klick ohne ein Wort;
    // antwortete er `{ok:false}`, war `gates` undefined, die Schleife lief null Mal — und
    // das erste echte Inserat entstand, ohne dass die Warnung je zu sehen war. Ein Gate,
    // das man nicht holen kann, ist keine Erlaubnis.
    setPublish('Prüfe Freigaben…', 'working');
    const gateReply = await chrome.runtime.sendMessage({ type: 'draft/gates' });
    if (!gateReply?.ok || !Array.isArray(gateReply.gates)) {
      throw new Error(gateReply?.error || 'Freigaben nicht erreichbar — Erweiterung neu laden und erneut versuchen.');
    }
    for (const gate of gateReply.gates) {
      setPublish('', '');
      if (!await askGate(gate)) return setPublish('Abgebrochen.', 'error');
      if (gate.remember) await chrome.runtime.sendMessage({ type: 'draft/confirmed' });
    }

    // 2. Hand the whole draft over. The worker recomputes the view and refuses a draft
    //    that is not ready — this side's `canPublish` is a rendering hint, not authority.
    setPublish('Wird veröffentlicht…', 'working');
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
          conditions: state.conditions,
          // Keine Sendungsgröße: die holt die Pipeline bei Vinted, sobald es eine
          // upload_session_id gibt. Hier stand ein Feld, das nie jemand gesetzt hat.
          photos: state.photos.map(p => ({ touchesEdge: p.touchesEdge, judged: p.judged === true }))
        },
        // Das INSERATSBILD, hier und nur hier kodiert: 1080×1350, zugeschnitten oder
        // gepolstert. Die Nachricht an den Worker kann keinen Blob tragen, deshalb
        // base64 — aber erst jetzt, nicht schon beim Aufbereiten, und aus `blob`.
        photos: await Promise.all(state.photos.map(async (p, i) => ({
          base64: arrayBufferToBase64(await p.blob.arrayBuffer()),
          mediaType: p.mediaType,
          filename: `foto-${i + 1}.jpg`
        })))
      }
    });
    const message = reply?.message || { kind: 'error', text: 'Fehler: unbekannt' };
    setPublish(message.text, message.kind);

    // Vinted disagreed. Adopt the cross-checked resolutions so the affected fields open up
    // with BOTH answers to pick from, and drop the confirmations the disagreement made
    // stale — a colour confirmed before Vinted objected is not a decision about the
    // objection.
    if (reply?.conflict && reply.resolved) {
      state.resolved = { ...state.resolved, ...reply.resolved };
      const open = conflictedFields(state.resolved);
      for (const key of open) delete state.confirmations[key];
      log('studio_conflict', { fields: open });
    }

    if (reply?.newUrl) {
      // Der Draft ist verbraucht. Ohne diese Zeile war der Knopf nach dem Erfolg sofort
      // wieder aktiv — und ein zweiter Klick legte dasselbe Inserat ein zweites Mal an,
      // ohne Gate, weil die Erst-Bestätigung gemerkt ist.
      state.publishedId = reply.newId;
      log('studio_published', { newId: reply.newId });
    }
  } catch (e) {
    // Auch was NEBEN der Pipeline schiefgeht — eine Nachricht, die den Worker nicht
    // erreicht — gehört ins Log. Sonst endet der Lauf dort wortlos.
    log('studio_publish_failed', { error: e.message });
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

$('reset').addEventListener('click', async () => {
  if (state.busy) return;
  // Die Rückfrage entscheidet lib/gates.js — hier wird sie nur gezeigt.
  const gate = resetGateFor({
    hasWork: state.photos.length > 0 || !!state.analysis,
    published: state.publishedId != null
  });
  if (gate && !await askGate(gate)) return;
  resetDraft();
});

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

// ---------- Log ----------
//
// The popup's panel, same behaviour: the tail on screen, the whole thing on the clipboard.
// Deliberately not a studio-flavoured variant — the log is what ends up in a bug report,
// and two formats would mean two things to read.

/** How many lines the panel shows. The clipboard gets all of them. */
const LOG_TAIL = 60;

async function refreshLog() {
  let lines = [];
  try {
    ({ [LOG_KEY]: lines = [] } = await chrome.storage.local.get(LOG_KEY));
  } catch (e) {
    // The panel is the thing people read when something is wrong. It failing silently is
    // the worst of both worlds, so it says so in its own <pre>.
    $('log-output').textContent = 'Log konnte nicht gelesen werden: ' + e.message;
    return;
  }
  $('logCount').textContent = String(lines.length);
  const out = $('log-output');
  out.textContent = lines.slice(-LOG_TAIL).join('\n');
  // Follow the tail while it is open — the interesting line is always the last one.
  if ($('logBox').open) out.scrollTop = out.scrollHeight;
}

// Every log() writes to storage, so this fires for the studio's own lines as well as for
// anything the service worker logs during publishing.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[LOG_KEY]) refreshLog();
  // Die Einstellungen wurden einmal beim Laden gelesen. Wer im Popup scharf schaltete,
  // während diese Seite offen stand, sah hier weiter „Testlauf" — und der Worker, der die
  // Einstellungen frisch liest, legte trotzdem ein echtes Inserat an. Das Schild, der
  // Knopf und der Satz darunter hängen alle an diesem Wert.
  // `getSettings()` statt `newValue`: gespeichert wird nur, was abweicht, und die
  // Voreinstellungen kommen erst beim Lesen dazu.
  if (changes[SETTINGS_KEY]) getSettings().then(next => { state.settings = next; render(); });
});

$('logBox').addEventListener('toggle', () => { if ($('logBox').open) refreshLog(); });

/**
 * The support bundle: version, what the draft currently holds, then the full log.
 *
 * The draft summary is the half a log line cannot carry — which ids were resolved and what
 * is still blocking. Photos are named by size only; no image data goes on the clipboard.
 */
$('copyLog').addEventListener('click', async e => {
  const button = e.currentTarget;
  const { [LOG_KEY]: lines = [] } = await chrome.storage.local.get(LOG_KEY);
  const view = currentView();
  const parts = [
    `Vinted Relist v${chrome.runtime.getManifest().version} — Studio`,
    `Titel: ${view.title || '(leer)'}`,
    `Profil: ${view.profile}`,
    `Felder: ${view.fields.map(f => `${f.label}=${f.value ?? '—'}[${f.state}]`).join(', ')}`,
    `IDs: katalog=${state.resolved.catalog?.id ?? '—'} marke=${state.resolved.brand?.id ?? '—'} `
      + `größe=${state.resolved.size?.id ?? '—'} farbe=${state.resolved.color?.id ?? '—'} `
      + `zustand=${state.condition ?? '—'} (${state.conditionMeta.source ?? '—'})`,
    `Größe laut KI: ${state.analysis?.size_label ?? '—'} (${state.analysis?.size_source ?? '—'}, `
      + `Foto ${state.analysis?.size_photo ?? '—'})`,
    `Fotos: ${state.photos.map(p => `${p.width}×${p.height}→KI ${p.modelWidth}×${p.modelHeight}`).join(' | ') || '(keine)'}`,
    `Blocker: ${view.blockers.join(' | ') || '(keine)'}`,
    '',
    '--- Log ---',
    lines.length ? lines.join('\n') : '(leer)'
  ];
  try {
    await navigator.clipboard.writeText(parts.join('\n'));
    button.classList.add('copied');
    flash(button, 'Kopiert ✓', 'Log & Fehler kopieren');
    setTimeout(() => button.classList.remove('copied'), 1500);
  } catch {
    flash(button, 'Fehler beim Kopieren', 'Log & Fehler kopieren');
  }
});

$('clearLog').addEventListener('click', async () => {
  await clearLog();
  refreshLog();
});

// ---------- Init ----------

state.settings = await getSettings();
state.priceMemory = await loadPriceMemory();
render();
refreshLog();
