/**
 * The recognition call — one request per article, every photo in it.
 *
 * ONE CALL, NOT TWO. Recognition, photo order and the crop check share the same images;
 * splitting them into two calls would upload the same bytes twice for nothing.
 *
 * STRUCTURED OUTPUT VIA TOOL USE, not "answer only with JSON". The tool's JSON schema is
 * enforced (`strict: true`), so the answer either fits the shape or the call fails — a
 * prompt asking politely for JSON gives neither guarantee.
 *
 * THE MODEL FILLS SLOTS, IT DOES NOT DECIDE. It returns strings plus a confidence;
 * title.js builds the title, resolve.js maps strings to Vinted ids, draft-view.js decides
 * what blocks publishing. Nothing here is used verbatim in a listing.
 *
 * WHY RAW `fetch` AND NOT THE SDK: the project has no bundler and no runtime dependencies
 * (ADR-0006), so `@anthropic-ai/sdk` is not an option. The one browser-specific piece is
 * the `anthropic-dangerous-direct-browser-access` header, without which CORS blocks the
 * call from an extension page.
 *
 * The call runs in the STUDIO, not the service worker: the key stays in the tab it was
 * unlocked in, and the photos never cross a message boundary.
 */
import { ApiError, ValidationError } from './errors.js';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
/**
 * Haiku, deliberately. Reading a label off a photo and filling twelve slots is perception,
 * not reasoning — the cheapest capable model is the right one, and the call happens once
 * per article on every listing.
 *
 * NOTE FOR A LATER SWITCH: `thinking: {type:'adaptive'}` and `output_config.effort` are
 * 4.6-and-later parameters and are REJECTED by Haiku 4.5. Omitting both is valid on every
 * model — the Opus family then simply thinks by default — so this request body survives a
 * change of `model` in either direction.
 */
export const MODEL = 'claude-haiku-4-5';
export const TOOL_NAME = 'artikel_erkennung';

const MAX_TOKENS = 4096;

const LANGUAGE_NAMES = {
  de: 'Deutsch', en: 'Englisch', fr: 'Französisch', nl: 'Niederländisch',
  it: 'Italienisch', es: 'Spanisch', pl: 'Polnisch'
};

const SIZE_SOURCES = ['label_photo', 'estimated', 'none'];
const CATEGORY_GROUPS = ['clothing', 'shoes', 'accessories', 'media', 'generic'];

/**
 * The answer shape. Every property is required and absence is expressed as `null`,
 * because `strict: true` needs `additionalProperties: false` plus a complete `required`
 * list — and because "field missing" and "nothing recognised" must not be the same thing.
 */
const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brand: { type: ['string', 'null'], description: 'Markenname, wie er auf dem Etikett steht. null, wenn nicht lesbar.' },
    brand_confidence: { type: 'number', description: 'Wie sicher ist die Marke? 0 bis 1.' },
    type: { type: ['string', 'null'], description: 'Art des Artikels, z. B. Hoodie, Sneaker, Umhängetasche.' },
    type_confidence: { type: 'number', description: 'Wie sicher ist die Art? 0 bis 1.' },
    size_label: { type: ['string', 'null'], description: 'Größe, genau wie angegeben (M, 38, 29/32).' },
    size_source: { type: 'string', enum: SIZE_SOURCES, description: 'Vom Etikett abgelesen, aus Proportionen geschätzt, oder gar nicht erkannt.' },
    category_group: { type: 'string', enum: CATEGORY_GROUPS, description: 'Warengruppe — bestimmt das Titelschema.' },
    colors: { type: 'array', items: { type: 'string' }, description: 'Sichtbare Hauptfarben, wichtigste zuerst.' },
    material: { type: ['string', 'null'], description: 'Material laut Pflegeetikett. null, wenn nicht lesbar.' },
    // Split in two on purpose: the sentence is prose only the model can write, the facts
    // are label/value pairs. That lets draft-view.js re-derive a fact from the field the
    // user just corrected instead of leaving the description contradicting the fields.
    description_sentence: { type: 'string', description: 'EIN Satz zum Artikel. Keine Fakten, keine Aufzählung.' },
    description_facts: {
      type: 'array',
      description: 'Zwei bis drei Fakten als Beschriftung und Wert, z. B. Material / Baumwolle.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: 'Beschriftung, z. B. Material, Passform, Besonderheit.' },
          value: { type: 'string', description: 'Der Wert dazu.' }
        },
        required: ['label', 'value']
      }
    },
    photo_order: {
      type: 'array',
      description: 'Vorgeschlagene Reihenfolge der Fotos, bestes Titelbild zuerst.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', description: 'Nummer des Fotos aus der Eingabe.' },
          role: { type: 'string', description: 'Was das Foto zeigt, in zwei bis drei Worten.' },
          cropped_off: { type: 'boolean', description: 'Ragt ein Teil des Artikels über den Bildrand hinaus?' }
        },
        required: ['index', 'role', 'cropped_off']
      }
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Was unsicher blieb und warum.' }
  },
  required: [
    'brand', 'brand_confidence', 'type', 'type_confidence', 'size_label', 'size_source',
    'category_group', 'colors', 'material', 'description_sentence', 'description_facts',
    'photo_order', 'notes'
  ]
};

/** The system prompt. Language and description template come from the settings. */
function systemPrompt(settings) {
  const language = LANGUAGE_NAMES[settings.draftLanguage] || LANGUAGE_NAMES.de;
  return [
    'Du erfasst gebrauchte Ware für ein Vinted-Inserat. Du bekommst alle Fotos eines',
    'einzelnen Artikels und füllst damit das Werkzeug aus.',
    '',
    `Sprache aller Texte: ${language}.`,
    '',
    'Was nicht sicher zu erkennen ist, ist null — nie geraten. Ein falsch geratener',
    'Markenname oder eine falsche Größe steht danach in einem öffentlichen Inserat und ist',
    'ein Sachmangel. Eine Größe gilt nur dann als vom Etikett abgelesen',
    '(size_source: label_photo), wenn du sie wirklich auf einem Etikett liest; aus den',
    'Proportionen geschätzte Größen sind estimated.',
    '',
    'Zur Fotoreihenfolge: das erste Foto entscheidet in der Trefferliste, ob jemand klickt.',
    'Nenne für jedes Foto in zwei bis drei Worten, was es zeigt.',
    '',
    'Zum Zuschnitt: die Fotos sind bereits automatisch zugeschnitten. Setze cropped_off,',
    'wenn ein Teil des Artikels über den Bildrand hinausragt.',
    '',
    'Vorlage für die Beschreibung:',
    settings.draftDescriptionTemplate,
    '',
    'Der eine Satz gehört in description_sentence, die Fakten einzeln in',
    'description_facts als Beschriftung und Wert. Beschriftungen, die auf ein erfasstes',
    'Feld zeigen, schreibst du genau so: Material, Farbe, Größe, Marke — dann kann eine',
    'spätere Korrektur im Formular den Fakt mitziehen.',
    '',
    'Fülle die Vorlage aus den erkannten Feldern. Erfinde nichts dazu, lass weg statt zu',
    'raten. Keine Maße und keine Angaben zum Zustand — beides wird separat erfasst.'
  ].join('\n');
}

/**
 * Build the request body. Pure: no fetch, no key — the key travels in the header, so a
 * logged or stored request body can never leak it.
 *
 * `images` are ALREADY encoded and downscaled ({ base64, mediaType }); the canvas work
 * belongs to the studio adapter, not here.
 */
export function buildAnalysisRequest(images, opts = {}) {
  if (!Array.isArray(images) || !images.length) throw new ValidationError('Mindestens ein Foto wird gebraucht.');
  const settings = opts.settings || {};

  // Each photo is announced with its index, so photo_order can refer back to it.
  const content = [];
  images.forEach((image, index) => {
    content.push({ type: 'text', text: `Foto ${index}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType || 'image/jpeg', data: image.base64 }
    });
  });
  content.push({ type: 'text', text: 'Erfasse diesen Artikel.' });

  return {
    model: opts.model || MODEL,
    max_tokens: opts.maxTokens || MAX_TOKENS,
    system: systemPrompt(settings),
    tools: [{
      name: TOOL_NAME,
      description: 'Trägt die erkannten Angaben zu einem Artikel ein.',
      strict: true,
      input_schema: ANALYSIS_SCHEMA
    }],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content }]
  };
}

// --- validation helpers ---------------------------------------------------------------
const bad = field => { throw new ValidationError(`Antwort der KI ungültig: ${field}`); };
const isString = v => typeof v === 'string';
const nullableString = v => v === null || isString(v);
const confidence = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const stringArray = v => Array.isArray(v) && v.every(isString);

/**
 * Validate the tool input and return it.
 *
 * A schema violation discards the WHOLE answer — a half-taken analysis is the shape of
 * bug that ends up as a wrong field in a public listing. `photoCount`, when given, also
 * bounds the photo indices.
 */
export function parseAnalysis(responseBody, photoCount) {
  if (responseBody?.stop_reason === 'refusal') throw new ValidationError('Die KI hat die Anfrage abgelehnt.');
  if (responseBody?.stop_reason === 'max_tokens') throw new ValidationError('Antwort der KI abgeschnitten — max_tokens erreicht.');

  const block = (responseBody?.content || []).find(b => b?.type === 'tool_use' && b.name === TOOL_NAME);
  const a = block?.input;
  if (!a || typeof a !== 'object') throw new ValidationError('Antwort der KI enthält keine Erfassung.');

  for (const key of ANALYSIS_SCHEMA.required) {
    if (!(key in a)) bad(`${key} fehlt`);
  }
  if (!nullableString(a.brand)) bad('brand');
  if (!confidence(a.brand_confidence)) bad('brand_confidence');
  if (!nullableString(a.type)) bad('type');
  if (!confidence(a.type_confidence)) bad('type_confidence');
  if (!nullableString(a.size_label)) bad('size_label');
  if (!SIZE_SOURCES.includes(a.size_source)) bad('size_source');
  if (!CATEGORY_GROUPS.includes(a.category_group)) bad('category_group');
  if (!stringArray(a.colors)) bad('colors');
  if (!nullableString(a.material)) bad('material');
  if (!isString(a.description_sentence)) bad('description_sentence');
  if (!stringArray(a.notes)) bad('notes');

  if (!Array.isArray(a.description_facts)) bad('description_facts');
  for (const fact of a.description_facts) {
    if (!fact || typeof fact !== 'object') bad('description_facts');
    if (!isString(fact.label)) bad('description_facts.label');
    if (!isString(fact.value)) bad('description_facts.value');
  }

  if (!Array.isArray(a.photo_order)) bad('photo_order');
  for (const entry of a.photo_order) {
    if (!entry || typeof entry !== 'object') bad('photo_order');
    if (!Number.isInteger(entry.index)) bad('photo_order.index');
    if (photoCount != null && (entry.index < 0 || entry.index >= photoCount)) bad('photo_order.index außerhalb der Fotos');
    if (!isString(entry.role)) bad('photo_order.role');
    if (typeof entry.cropped_off !== 'boolean') bad('photo_order.cropped_off');
  }

  return a;
}

/**
 * Adapter: build → POST → parse.
 *
 * `fetchImpl` and `log` are injected so the tests exercise the whole path without a
 * network. Nothing that is logged here ever carries the key.
 */
export async function analyse(images, opts = {}) {
  const { apiKey, fetchImpl = globalThis.fetch, log = () => {} } = opts;
  if (!apiKey) throw new ValidationError('Kein API-Key entsperrt.');

  const body = buildAnalysisRequest(images, opts);
  log('ai_request', { model: body.model, photos: images.length });

  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      // Without this the browser refuses the cross-origin call from the studio page.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) {
    log('ai_error', { status: res.status });
    throw new ApiError(res.status, text);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError('Antwort der KI war kein JSON.');
  }

  const analysis = parseAnalysis(parsed, images.length);
  log('ai_ok', { usage: parsed.usage, stop_reason: parsed.stop_reason });
  return analysis;
}
