import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL, API_URL, TOOL_NAME, buildAnalysisRequest, parseAnalysis, analyse
} from '../lib/ai.js';
import { DEFAULT_SETTINGS, DEFAULT_DESCRIPTION_TEMPLATE } from '../lib/settings.js';
import { CONDITIONS, CONDITION_VALUES } from '../lib/condition.js';

const API_KEY = 'sk-ant-api03-supersecret';
const IMAGES = [
  { base64: 'AAAA', mediaType: 'image/jpeg' },
  { base64: 'BBBB', mediaType: 'image/jpeg' }
];

/** A schema-conforming tool_use response, as the API returns it. */
function response(overrides = {}) {
  return {
    id: 'msg_1',
    model: MODEL,
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: '' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: TOOL_NAME,
        input: {
          brand: 'Nike',
          brand_confidence: 0.92,
          type: 'Hoodie',
          type_confidence: 0.97,
          size_label: 'M',
          size_source: 'label_photo',
          size_photo: 0,
          condition: 'very_good',
          condition_confidence: 0.85,
          condition_evidence: 'kaum Gebrauchsspuren, Bündchen fest',
          category_group: 'clothing',
          colors: ['schwarz'],
          material: 'Baumwolle',
          isbn: null,
          book_language: null,
          description_sentence: 'Ein schlichter Hoodie in gerader Passform.',
          description_facts: [
            { label: 'Material', value: 'Baumwolle' },
            { label: 'Passform', value: 'gerade' }
          ],
          photo_order: [
            { index: 1, role: 'Gesamtansicht vorn', cropped_off: false, distractions: 'Füße des Fotografen', article_box: { x: 0.05, y: 0.02, w: 0.9, h: 0.72 } },
            { index: 0, role: 'Etikett', cropped_off: true, distractions: null, article_box: null }
          ],
          notes: ['Etikett leicht unscharf'],
          ...overrides
        }
      }
    ]
  };
}

/** A response whose tool input is missing or malformed in exactly one place. */
function broken(patch) {
  const r = response();
  Object.assign(r.content[1].input, patch);
  return r;
}

// ---------- buildAnalysisRequest ----------

test('buildAnalysisRequest: one call carries every photo', () => {
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  const blocks = body.messages[0].content;
  const imageBlocks = blocks.filter(b => b.type === 'image');
  assert.equal(imageBlocks.length, 2);
  assert.equal(imageBlocks[0].source.type, 'base64');
  assert.equal(imageBlocks[0].source.media_type, 'image/jpeg');
  assert.equal(imageBlocks[0].source.data, 'AAAA');
});

test('buildAnalysisRequest: numbers the photos so the model can order them', () => {
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  const texts = body.messages[0].content.filter(b => b.type === 'text').map(b => b.text);
  assert.ok(texts.some(t => t.includes('Foto 0')));
  assert.ok(texts.some(t => t.includes('Foto 1')));
});

test('buildAnalysisRequest: structured output goes through tool use, not "answer in JSON"', () => {
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].name, TOOL_NAME);
  assert.equal(body.tools[0].strict, true);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: TOOL_NAME });
  assert.equal(body.tools[0].input_schema.additionalProperties, false);
});

test('buildAnalysisRequest: strict schema requires every property (absence is expressed as null)', () => {
  const schema = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS }).tools[0].input_schema;
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
});

test('buildAnalysisRequest: carries language and description template from the settings', () => {
  const body = buildAnalysisRequest(IMAGES, {
    settings: { ...DEFAULT_SETTINGS, draftLanguage: 'fr', draftDescriptionTemplate: 'MEINE VORLAGE' }
  });
  assert.ok(body.system.includes('Französisch'), body.system);
  assert.ok(body.system.includes('MEINE VORLAGE'));
  assert.ok(!body.system.includes(DEFAULT_DESCRIPTION_TEMPLATE));
});

test('buildAnalysisRequest: the system prompt forbids guessing', () => {
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  assert.match(body.system, /null/);
  assert.match(body.system, /rate|Raten|geraten/i);
});

test('buildAnalysisRequest: the prompt says WHERE size labels sit, not just to read one', () => {
  // "Größe, wenn lesbar" produced nulls on articles whose label was photographed. The
  // places a label hides are the part the model cannot infer from the field name.
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  assert.match(body.system, /Nacken/);
  assert.match(body.system, /Innensohle/);
  assert.match(body.system, /JEDES Foto/);
  assert.match(body.system, /ZEICHENGETREU/, 'no unit conversion, no tidying up');
});

test('buildAnalysisRequest: der Prompt sagt, WO die ISBN steht', () => {
  // Vinted lehnt ein Buchinserat ohne ISBN ab (gemessen 2026-08-23). „Gib die ISBN an"
  // hilft einem Modell wenig — wo sie steht und wie sie aussieht, schon.
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  assert.match(body.system, /Strichcode/);
  assert.match(body.system, /978/);
  assert.match(body.system, /geraten wird sie nicht/, 'eine erfundene ISBN benennt ein fremdes Buch');
});

test('buildAnalysisRequest: der Prompt sagt, WIE die Box zu messen ist', () => {
  // „Lieber etwas Hintergrund zu viel" stand schon drin, und trotzdem lief im Titelbild
  // eines eingestellten Inserats der rechte Ärmel in die Bildkante. Eine Haltung ist keine
  // Anweisung: die Teile, die zuerst herausfallen, muss man benennen.
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  assert.match(body.system, /FINGERBREIT HINTERGRUND/);
  assert.match(body.system, /Ärmelspitzen/);
  assert.match(body.system, /Saum/);
});

test('buildAnalysisRequest: the box is the ANSWER to the distractions, not a second opinion', () => {
  // Im ersten echten Inserat (2026-08-21) standen unten weiterhin die Füße des
  // Fotografen im Bild — das Modell hatte sie benannt UND die Box benutzt. Beide Felder
  // sprachen nur nicht miteinander: der Prompt verlangte eine „großzügige" Box und sagte
  // nirgends, dass das Genannte draußen zu liegen hat.
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  assert.match(body.system, /AUSSERHALB der\s+Box/);
  assert.match(body.system, /untere Kante/, 'sagt, was zu tun ist, nicht nur was falsch wäre');
  assert.match(body.system, /Artikel Vorrang/, 'berührt die Störung den Artikel, gewinnt der Artikel');
  assert.doesNotMatch(body.system, /GANZ und großzügig/, 'die alte Formel lud genau dazu ein');
});

test('buildAnalysisRequest: die Box gehört auf JEDES Foto, nicht nur auf gestörte', () => {
  // Der Regressionsfall (2026-08-23, Version 0.108): ein grauer Pullover flach auf
  // Holzboden, keine Störung. Der alte Prompt ließ die Box dann null — und der Zuschnitt
  // hing allein an der Hintergrund-Heuristik, die auf strukturiertem Boden (Holzmaserung,
  // ähnliche Helligkeit) den Artikel nicht mittig trifft. Die Box ist jetzt das, worauf
  // der 4:5-Rahmen zentriert wird, also muss sie auf jedem Foto stehen.
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  assert.match(body.system, /JEDEM FOTO/, 'die Box wird für jedes Foto verlangt');
  assert.match(body.system, /zentriert/i, 'der Prompt sagt, wozu die Box dient');
  // null ist jetzt der Ausnahmefall „füllt das Bild randlos", nicht mehr „nichts Störendes".
  assert.match(body.system, /randlos ausfüllt/);
  // Auch die Schema-Beschreibung des Felds trägt die neue Regel.
  const box = body.tools[0].input_schema.properties.photo_order.items.properties.article_box;
  assert.match(box.description, /JEDEM Foto/);
});

test('buildAnalysisRequest: the condition is judged by Vinted\'s own definitions', () => {
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  for (const c of CONDITIONS) {
    assert.ok(body.system.includes(c.value), `${c.value} missing from the prompt`);
    assert.ok(body.system.includes(c.definition), `${c.value}: Vinted's wording, not ours`);
  }
  assert.match(body.system, /schlechtere Stufe/, 'in doubt, downwards — over-stated goods get returned');
});

test('buildAnalysisRequest: the condition enum offers an explicit "could not tell"', () => {
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  const schema = body.tools[0].input_schema;
  assert.deepEqual(schema.properties.condition.enum, [...CONDITION_VALUES, 'unknown']);
  for (const key of ['condition', 'condition_confidence', 'condition_evidence', 'size_photo']) {
    assert.ok(schema.required.includes(key), `${key} must be required — absence is stated, not omitted`);
  }
});

test('buildAnalysisRequest: uses Haiku and sends no 4.6-only parameters', () => {
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS });
  assert.equal(body.model, MODEL);
  assert.match(MODEL, /haiku/);
  assert.ok(body.max_tokens >= 4096);
  // `thinking: adaptive` and `output_config.effort` are rejected by Haiku 4.5; leaving
  // both out keeps the body valid on every model.
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
});

test('buildAnalysisRequest: contains no API key — the key belongs in the header', () => {
  const body = buildAnalysisRequest(IMAGES, { settings: DEFAULT_SETTINGS, apiKey: API_KEY });
  assert.ok(!JSON.stringify(body).includes(API_KEY));
  assert.ok(!JSON.stringify(body).includes('sk-ant'));
});

test('buildAnalysisRequest: refuses to build a request without photos', () => {
  assert.throws(() => buildAnalysisRequest([], { settings: DEFAULT_SETTINGS }), /Foto/);
});

// ---------- parseAnalysis ----------

test('parseAnalysis: a schema-conforming answer is parsed completely', () => {
  const a = parseAnalysis(response());
  assert.equal(a.brand, 'Nike');
  assert.equal(a.brand_confidence, 0.92);
  assert.equal(a.size_source, 'label_photo');
  assert.equal(a.category_group, 'clothing');
  assert.deepEqual(a.colors, ['schwarz']);
  assert.equal(a.photo_order.length, 2);
  assert.equal(a.photo_order[1].cropped_off, true);
  assert.deepEqual(a.notes, ['Etikett leicht unscharf']);
});

test('parseAnalysis: null stays null, it never becomes an empty string', () => {
  const a = parseAnalysis(broken({ brand: null, size_label: null, material: null }));
  assert.equal(a.brand, null);
  assert.equal(a.size_label, null);
  assert.equal(a.material, null);
  assert.notEqual(a.brand, '');
});

test('parseAnalysis: a schema violation is discarded whole, never taken in part', () => {
  // The brand is fine, the confidence is not — the whole answer goes, not just that field.
  assert.throws(() => parseAnalysis(broken({ brand_confidence: 'hoch' })), /brand_confidence/);
});

test('parseAnalysis: eine ISBN als ZAHL kostet nicht die ganze Analyse', () => {
  // Die ISBN ist das eine Feld, dessen natürlicher Wert eine lange Ziffernfolge ist — und
  // darauf antwortet ein Modell gern mit einer Zahl. Vorher fiel deswegen alles weg: Marke,
  // Größe, Zustand, Fotoreihenfolge. Für ein T-Shirt wegen einer Angabe, die dort keine
  // Rolle spielt.
  const a = parseAnalysis(broken({ isbn: 9783161484100 }));
  assert.equal(a.isbn, '9783161484100');
  assert.equal(a.brand, 'Nike', 'der Rest der Analyse steht');
});

test('parseAnalysis: die ISBN wird zur Zeichenkette, nicht zur Vermutung', () => {
  // Umgewandelt wird nur die FORM. Ob die Ziffern eine ISBN ergeben, entscheidet
  // `book.js#normaliseIsbn` — dort, wo die Folge sichtbar ist.
  assert.equal(parseAnalysis(broken({ isbn: 42 })).isbn, '42');
  assert.equal(parseAnalysis(broken({ isbn: null })).isbn, null);
  assert.throws(() => parseAnalysis(broken({ isbn: NaN })), /isbn/, 'keine Zahl ist keine Ziffernfolge');
  assert.throws(() => parseAnalysis(broken({ isbn: ['978'] })), /isbn/);
});

test('parseAnalysis: auch Größe und Marke dürfen als Zahl kommen', () => {
  // Dieselbe Lage wie bei der ISBN: „38" und „146" SIND Größen, „501" ist eine Marke. Ein
  // eigenes `if` je Feld hätte man wieder erst nach dem nächsten Fehlschlag geschrieben.
  assert.equal(parseAnalysis(broken({ size_label: 146 })).size_label, '146');
  assert.equal(parseAnalysis(broken({ brand: 501 })).brand, '501');
});

test('parseAnalysis: in einem Prosafeld ist eine Zahl KEINE Schreibweise', () => {
  // `condition_evidence` ist ein Halbsatz, `description_sentence` ein Satz. Eine Zahl darin
  // ist ein Missverständnis, kein Formproblem — und dann gilt die Regel dieser Datei: lieber
  // die ganze Antwort verwerfen als eine halb genommene. Genau deshalb ist `DIGIT_BEARING`
  // eine benannte Liste und nicht „alles, was das Schema als Zeichenkette führt".
  assert.throws(() => parseAnalysis(broken({ condition_evidence: 42 })), /condition_evidence/);
  assert.throws(() => parseAnalysis(broken({ description_sentence: 42 })), /description_sentence/);
  assert.throws(() => parseAnalysis(broken({ material: 42 })), /material/);
});

test('parseAnalysis: rejects an out-of-range confidence', () => {
  assert.throws(() => parseAnalysis(broken({ type_confidence: 1.4 })), /type_confidence/);
});

test('parseAnalysis: rejects an unknown enum value', () => {
  assert.throws(() => parseAnalysis(broken({ size_source: 'geschätzt' })), /size_source/);
  assert.throws(() => parseAnalysis(broken({ category_group: 'moebel' })), /category_group/);
  assert.throws(() => parseAnalysis(broken({ condition: 'bespielt' })), /condition/);
  assert.throws(() => parseAnalysis(broken({ condition: null })), /condition/);
});

test('parseAnalysis: the condition arrives with a confidence and what it was based on', () => {
  const a = parseAnalysis(response());
  assert.equal(a.condition, 'very_good');
  assert.equal(a.condition_confidence, 0.85);
  assert.equal(a.condition_evidence, 'kaum Gebrauchsspuren, Bündchen fest');
  // "Looked and could not decide" is a real answer, not a malformed one.
  assert.equal(parseAnalysis(broken({ condition: 'unknown', condition_evidence: null })).condition, 'unknown');
});

test('parseAnalysis: rejects a condition confidence outside 0..1', () => {
  assert.throws(() => parseAnalysis(broken({ condition_confidence: 1.4 })), /condition_confidence/);
  assert.throws(() => parseAnalysis(broken({ condition_confidence: '0.9' })), /condition_confidence/);
  assert.throws(() => parseAnalysis(broken({ condition_evidence: 42 })), /condition_evidence/);
});

test('parseAnalysis: size_photo must name a photo that exists', () => {
  assert.equal(parseAnalysis(broken({ size_photo: null }), 2).size_photo, null);
  assert.equal(parseAnalysis(broken({ size_photo: 1 }), 2).size_photo, 1);
  assert.throws(() => parseAnalysis(broken({ size_photo: 5 }), 2), /size_photo/);
  assert.throws(() => parseAnalysis(broken({ size_photo: -1 }), 2), /size_photo/);
  assert.throws(() => parseAnalysis(broken({ size_photo: '0' }), 2), /size_photo/);
});

test('parseAnalysis: rejects a missing field rather than defaulting it', () => {
  const r = response();
  delete r.content[1].input.description_sentence;
  assert.throws(() => parseAnalysis(r), /description_sentence/);
});

test('parseAnalysis: the description arrives split into a sentence and facts', () => {
  const a = parseAnalysis(response());
  assert.match(a.description_sentence, /Hoodie/);
  assert.equal(a.description_facts.length, 2);
  assert.deepEqual(a.description_facts[0], { label: 'Material', value: 'Baumwolle' });
});

test('parseAnalysis: rejects a malformed fact rather than half-taking it', () => {
  assert.throws(() => parseAnalysis(broken({ description_facts: [{ label: 'Material' }] })), /description_facts/);
  assert.throws(() => parseAnalysis(broken({ description_facts: 'aus Baumwolle' })), /description_facts/);
});

test('parseAnalysis: rejects a malformed photo_order entry', () => {
  assert.throws(() => parseAnalysis(broken({ photo_order: [{ index: 0 }] })), /photo_order/);
  assert.throws(() => parseAnalysis(broken({ photo_order: 'erst das vordere' })), /photo_order/);
});

test('parseAnalysis: rejects a photo index that does not exist', () => {
  assert.throws(
    () => parseAnalysis(broken({ photo_order: [{ index: 7, role: 'x', cropped_off: false }] }), 2),
    /photo_order/
  );
});

test('parseAnalysis: rejects colours or notes that are not strings', () => {
  assert.throws(() => parseAnalysis(broken({ colors: [1, 2] })), /colors/);
  assert.throws(() => parseAnalysis(broken({ notes: [{ text: 'x' }] })), /notes/);
});

test('parseAnalysis: a response without a tool call is an error, not an empty draft', () => {
  assert.throws(() => parseAnalysis({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Kann ich nicht.' }] }), /Antwort/);
  assert.throws(() => parseAnalysis({}), /Antwort/);
  assert.throws(() => parseAnalysis(null), /Antwort/);
});

test('parseAnalysis: a refusal is reported as such', () => {
  assert.throws(
    () => parseAnalysis({ stop_reason: 'refusal', content: [] }),
    /abgelehnt/
  );
});

test('parseAnalysis: a truncated answer is rejected — half a tool input is not a draft', () => {
  const r = response();
  r.stop_reason = 'max_tokens';
  assert.throws(() => parseAnalysis(r), /abgeschnitten/);
});

// ---------- analyse ----------

function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body)
    };
  };
  impl.calls = calls;
  return impl;
}

test('analyse: sends the key in the header, with the browser-access header', async () => {
  const fetchImpl = fakeFetch(response());
  await analyse(IMAGES, { settings: DEFAULT_SETTINGS, apiKey: API_KEY, fetchImpl });

  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, API_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], API_KEY);
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(init.headers['anthropic-version']);
  assert.ok(!init.body.includes(API_KEY), 'the key must not travel in the body');
});

test('analyse: returns the parsed analysis', async () => {
  const a = await analyse(IMAGES, {
    settings: DEFAULT_SETTINGS, apiKey: API_KEY, fetchImpl: fakeFetch(response())
  });
  assert.equal(a.brand, 'Nike');
});

test('analyse: never logs the API key', async () => {
  const lines = [];
  await analyse(IMAGES, {
    settings: DEFAULT_SETTINGS,
    apiKey: API_KEY,
    fetchImpl: fakeFetch(response()),
    log: (event, data) => lines.push(event + ' ' + JSON.stringify(data))
  });
  assert.ok(lines.length, 'nothing was logged at all');
  for (const line of lines) {
    assert.ok(!line.includes(API_KEY), line);
    assert.ok(!line.includes('sk-ant'), line);
  }
});

test('analyse: a missing key fails before the request goes out', async () => {
  const fetchImpl = fakeFetch(response());
  await assert.rejects(
    () => analyse(IMAGES, { settings: DEFAULT_SETTINGS, apiKey: '', fetchImpl }),
    /API-Key/
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('analyse: a non-2xx response throws with the status', async () => {
  await assert.rejects(
    () => analyse(IMAGES, {
      settings: DEFAULT_SETTINGS,
      apiKey: API_KEY,
      fetchImpl: fakeFetch({ error: { message: 'overloaded' } }, { status: 529 })
    }),
    err => err.status === 529
  );
});

test('analyse: a non-JSON body is a clear error, not a crash', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' });
  await assert.rejects(
    () => analyse(IMAGES, { settings: DEFAULT_SETTINGS, apiKey: API_KEY, fetchImpl }),
    /Antwort/
  );
});
