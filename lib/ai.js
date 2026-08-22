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
import { CONDITIONS, CONDITION_VALUES } from './condition.js';

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
 * The five Vinted stages plus an explicit "could not tell".
 *
 * `unknown` rather than `null`, so the enum stays a plain list of strings — `strict: true`
 * is happiest that way, and "the model looked and could not decide" is a real answer that
 * deserves a name. `chooseCondition` finds no symbol for it and falls back to the setting.
 */
const CONDITION_ANSWERS = [...CONDITION_VALUES, 'unknown'];

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
    size_label: { type: ['string', 'null'], description: 'Größe, genau wie angegeben (M, 38, 29/32). null, wenn nirgends lesbar.' },
    size_source: { type: 'string', enum: SIZE_SOURCES, description: 'Vom Etikett abgelesen, aus Proportionen geschätzt, oder gar nicht erkannt.' },
    size_photo: { type: ['integer', 'null'], description: 'Nummer des Fotos, auf dem die Größe steht. null, wenn keins.' },
    condition: { type: 'string', enum: CONDITION_ANSWERS, description: 'Zustand nach Vinteds Stufen. unknown, wenn die Fotos das nicht hergeben.' },
    condition_confidence: { type: 'number', description: 'Wie sicher ist der Zustand? 0 bis 1.' },
    condition_evidence: { type: ['string', 'null'], description: 'Was auf den Fotos zu diesem Zustand geführt hat, in einem Halbsatz.' },
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
          cropped_off: { type: 'boolean', description: 'Ragt ein Teil des Artikels über den Bildrand hinaus?' },
          distractions: { type: ['string', 'null'], description: 'Was außer dem Artikel im Bild ist — Füße, Hände, Möbel. null, wenn nichts.' },
          article_box: {
            type: ['object', 'null'],
            additionalProperties: false,
            description: 'Wo der Artikel im Bild liegt, als Anteil der Bildkante (0 bis 1). null, wenn er das ganze Bild füllt.',
            properties: {
              x: { type: 'number', description: 'Linke Kante, 0 = ganz links.' },
              y: { type: 'number', description: 'Obere Kante, 0 = ganz oben.' },
              w: { type: 'number', description: 'Breite als Anteil der Bildbreite.' },
              h: { type: 'number', description: 'Höhe als Anteil der Bildhöhe.' }
            },
            required: ['x', 'y', 'w', 'h']
          }
        },
        required: ['index', 'role', 'cropped_off', 'distractions', 'article_box']
      }
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Was unsicher blieb und warum.' }
  },
  required: [
    'brand', 'brand_confidence', 'type', 'type_confidence', 'size_label', 'size_source',
    'size_photo', 'condition', 'condition_confidence', 'condition_evidence',
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
    'ein Sachmangel.',
    '',
    'ZUR GRÖSSE. Sieh dir dafür JEDES Foto einzeln an, auch die, auf denen der Artikel nur',
    'nebensächlich ist. Größen stehen auf eingenähten Etiketten im Nacken, im Bund, in der',
    'Seitennaht, auf dem Pflegeetikett, bei Schuhen auf der Innensohle, der Lasche oder dem',
    'Karton. Etiketten sind oft klein, verdreht, geknickt oder blass — lies trotzdem so',
    'genau du kannst, bevor du aufgibst.',
    'Übernimm die Größe ZEICHENGETREU, so wie sie dasteht: "M", "38", "29/32", "10.5 UK".',
    'Rechne nichts um und vereinheitliche nichts. Steht mehreres da, nimm die Angabe vom',
    'Größenetikett, nicht die aus der Pflegeanleitung.',
    'size_source ist label_photo NUR, wenn du die Größe wirklich auf einem Etikett gelesen',
    'hast — dann trag in size_photo die Nummer dieses Fotos ein. Hast du sie aus den',
    'Proportionen geschätzt, ist es estimated. Findest du gar nichts, ist size_label null',
    'und size_source none; schreib in notes, woran es lag (z. B. "kein Etikett fotografiert").',
    '',
    'ZUM ZUSTAND. Beurteile ihn nach Vinteds eigenen Stufen:',
    ...CONDITIONS.map(c => `  ${c.value} — ${c.label}: ${c.definition}`),
    'Entscheide danach, was auf den Fotos zu SEHEN ist: hängendes Etikett, Originalfaltung,',
    'Knötchen, Pilling, Verwaschung, ausgetretene Sohlen, Flecken, Risse, fehlende Knöpfe.',
    'Im Zweifel die schlechtere Stufe — zu gut angegebene Ware wird reklamiert, zu',
    'zurückhaltend angegebene nicht. Reichen die Fotos nicht, ist condition unknown; das',
    'ist eine gültige Antwort und besser als eine geratene Stufe.',
    'In condition_evidence gehört in einem Halbsatz, was den Ausschlag gab.',
    '',
    'Zur Fotoreihenfolge: das erste Foto entscheidet in der Trefferliste, ob jemand klickt.',
    'Nenne für jedes Foto in zwei bis drei Worten, was es zeigt.',
    '',
    'ZUM ZUSCHNITT. Du bekommst die Fotos SO, WIE SIE AUFGENOMMEN WURDEN — ungeschnitten.',
    'Fürs Inserat werden sie anschließend auf das Format 4:5 gebracht, und DEIN Urteil',
    'entscheidet, wie: nicht ein Automatismus, der nur Hintergrund von Nicht-Hintergrund',
    'unterscheidet und deshalb Füße des Fotografen, Hände, Möbelkanten oder ein zweites',
    'Kleidungsstück für den Artikel hält.',
    '',
    'Für jedes Foto:',
    '  · distractions — was außer dem Artikel im Bild ist, oder null.',
    '  · article_box — wo das liegt, was auf diesem Foto GEZEIGT werden soll, als Anteil',
    '    der Bildkante: x und y sind die linke bzw. obere Kante, w und h Breite und Höhe,',
    '    alle zwischen 0 und 1. Bei einem Foto des ganzen Artikels ist das der Artikel; bei',
    '    einer Aufnahme des Etiketts ist es das Etikett samt Rand, nicht das Kleidungsstück',
    '    drumherum. Die Box umschließt ihren Gegenstand GANZ: lieber etwas Hintergrund zu',
    '    viel als ein abgeschnittener Ärmel oder eine halbe Zahl.',
    '    DIE BOX IST DIE ANTWORT AUF distractions: was du dort nennst, muss AUSSERHALB der',
    '    Box liegen. Schreibst du „Füße des Fotografen unten" und die Füße liegen trotzdem',
    '    in der Box, hast du sie benannt und im Bild gelassen — dann zieh die untere Kante',
    '    hoch, bis sie draußen sind. Geht beides nicht zugleich, weil die Störung den',
    '    Artikel berührt, hat der Artikel Vorrang und die Störung bleibt drin.',
    '    Ist nichts Störendes im Bild und soll ohnehin alles zu sehen bleiben, ist',
    '    article_box null.',
    '  · cropped_off — true, wenn ein Teil des Artikels schon in der Aufnahme über den',
    '    Bildrand hinausragt. Das ist eine Aussage über das Foto, nicht über den Zuschnitt.',
    '',
    'Vorlage für die Beschreibung:',
    settings.draftDescriptionTemplate,
    '',
    'Der eine Satz gehört in description_sentence, die Fakten einzeln in',
    'description_facts als Beschriftung und Wert. Beschriftungen, die auf ein erfasstes',
    'Feld zeigen, schreibst du genau so: Material, Farbe, Größe, Marke — dann kann eine',
    'spätere Korrektur im Formular den Fakt mitziehen.',
    '',
    'WICHTIG für description_sentence: dort stehen KEINE Marke, KEINE Farbe, KEINE Größe',
    'und KEIN Material. Diese vier sind eigene Felder und werden beim Prüfen oft korrigiert;',
    'ein Satz wie „Blaues T-Shirt von Superdry" widerspricht danach dem Inserat, weil der',
    'Fließtext nicht mitkorrigiert werden kann. Schreib stattdessen, was den Artikel',
    'ausmacht: Schnitt, Passform, Verarbeitung, Details, Trageeindruck.',
    '',
    'Fülle die Vorlage aus den erkannten Feldern. Erfinde nichts dazu, lass weg statt zu',
    'raten. Keine Maße, und keine Zustandsangaben im Text — der Zustand steht als eigenes',
    'Feld im Inserat, und was dir daran aufgefallen ist, gehört in condition_evidence.'
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
  if (!(a.size_photo === null || Number.isInteger(a.size_photo))) bad('size_photo');
  if (photoCount != null && Number.isInteger(a.size_photo)
      && (a.size_photo < 0 || a.size_photo >= photoCount)) bad('size_photo außerhalb der Fotos');
  if (!CONDITION_ANSWERS.includes(a.condition)) bad('condition');
  if (!confidence(a.condition_confidence)) bad('condition_confidence');
  if (!nullableString(a.condition_evidence)) bad('condition_evidence');
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
    if (!nullableString(entry.distractions)) bad('photo_order.distractions');
    // Only the SHAPE is checked here. Whether the box is plausible — inside the image, not
    // absurdly small — is `crop.boxFromModel`'s call, because that is where the consequence
    // of a wrong box lives.
    if (entry.article_box !== null) {
      const b = entry.article_box;
      if (!b || typeof b !== 'object') bad('photo_order.article_box');
      for (const key of ['x', 'y', 'w', 'h']) {
        if (typeof b[key] !== 'number' || !Number.isFinite(b[key])) bad(`photo_order.article_box.${key}`);
      }
    }
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
