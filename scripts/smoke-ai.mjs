/**
 * Smoke test für lib/ai.js gegen die echte Anthropic-API.
 *
 * Prüft die Stellen, die kein Unit-Test abdecken kann: ob die API das erzwungene
 * `tool_choice` akzeptiert, ob das `strict`-Schema so durchgeht wie gebaut — und vor allem,
 * OB DAS MODELL DIE GRÖSSE VOM ETIKETT LIEST. Das ist keine Frage der Formulierung,
 * sondern eine der Auflösung, und beantworten lässt sie sich nur mit einem echten Foto.
 *
 * Braucht keinen Browser und kein Canvas — deshalb wird das Foto hier NICHT
 * heruntergerechnet. Nimm eine Datei unter ~4 MB.
 *
 *   ANTHROPIC_API_KEY=sk-ant-… node scripts/smoke-ai.mjs pfad/zum/foto.jpg [weitere.jpg …]
 *
 * Besser noch, damit der Key nicht in der Shell-History landet:
 *
 *   read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY
 *   node scripts/smoke-ai.mjs foto.jpg
 *
 * Der Key wird nur aus der Umgebung gelesen und nie ausgegeben. Danach löschbar.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { analyse } from '../lib/ai.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';

const MAX_BYTES = 4_500_000; // die API weist deutlich größere Bilder ab
const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
/** Oberhalb dieser Kantenlänge rechnet Anthropic serverseitig herunter — siehe canvas.js. */
const AI_EDGE = 1568;

/**
 * Bildmaße aus dem Dateikopf, ohne Abhängigkeit.
 *
 * Reicht für JPEG und PNG, und genau die braucht es: ohne die Maße ist nicht zu sagen, ob
 * ein „size_label: null" am Modell liegt oder daran, dass das Etikett auf 60 Pixel
 * geschrumpft war. null, wenn der Kopf nicht gelesen werden kann — dann fehlt eben eine
 * Angabe, geraten wird keine.
 */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; // PNG IHDR
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // kein JPEG
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF15, ohne die vier, die keine Rahmenköpfe sind
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc, 0xd8].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) break; // Bildende / Beginn der Bilddaten
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const apiKey = process.env.ANTHROPIC_API_KEY;
const files = process.argv.slice(2);

if (!apiKey) {
  console.error('ANTHROPIC_API_KEY fehlt. Aufruf:\n  ANTHROPIC_API_KEY=sk-ant-… node scripts/smoke-ai.mjs foto.jpg');
  process.exit(2);
}
if (!files.length) {
  console.error('Mindestens ein Foto angeben:\n  node scripts/smoke-ai.mjs foto1.jpg foto2.jpg');
  process.exit(2);
}

const images = [];
for (const file of files) {
  const mediaType = MEDIA_TYPES[path.extname(file).toLowerCase()];
  if (!mediaType) {
    console.error(`${file}: unbekannter Bildtyp — jpg, png oder webp.`);
    process.exit(2);
  }
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (e) {
    console.error(`${file}: ${e.code === 'ENOENT' ? 'nicht gefunden.' : e.message}`);
    process.exit(2);
  }
  if (bytes.length > MAX_BYTES) {
    console.error(`${file}: ${(bytes.length / 1e6).toFixed(1)} MB — zu groß. Nimm eine kleinere Datei.`);
    process.exit(2);
  }
  const size = imageSize(bytes);
  const edge = size ? Math.max(size.w, size.h) : null;
  // Sagt sofort, ob der Test überhaupt fair ist: ein Bild weit über AI_EDGE wird
  // serverseitig heruntergerechnet, eines weit darunter hat weniger Pixel als das, was die
  // Extension schickt — beides würde das Ergebnis verzerren.
  const verdict = edge == null ? '(Maße nicht lesbar)'
    : edge > AI_EDGE ? `${size.w}×${size.h} → wird auf ${AI_EDGE} heruntergerechnet`
    : `${size.w}×${size.h}`;
  images.push({ base64: bytes.toString('base64'), mediaType, file, size });
  console.log(`geladen: Foto ${images.length - 1} — ${file} (${(bytes.length / 1e6).toFixed(2)} MB, ${verdict})`);
}

console.log(`\n→ ein Call mit ${images.length} Foto(s)…\n`);

try {
  const analysis = await analyse(images, {
    apiKey,
    settings: DEFAULT_SETTINGS,
    log: (event, data) => console.log(`  [${event}]`, JSON.stringify(data))
  });
  console.log('\n✓ Antwort geparst.\n');

  // --- der Befund, wegen dem dieses Skript meistens läuft ----------------------------
  const src = { label_photo: 'vom Etikett gelesen', estimated: 'aus den Proportionen geschätzt', none: 'nicht gefunden' };
  console.log('GRÖSSE');
  console.log(`  gelesen      : ${analysis.size_label ?? '— nichts —'}`);
  console.log(`  Herkunft     : ${src[analysis.size_source] || analysis.size_source}`);
  console.log(`  auf Foto     : ${analysis.size_photo ?? '—'}${
    analysis.size_photo != null ? ` (${images[analysis.size_photo]?.file ?? '?'})` : ''}`);
  if (analysis.size_source !== 'label_photo') {
    console.log('  → Steht die Größe auf einem der Fotos wirklich drauf, dann liegt es an den');
    console.log('    Pixeln, nicht am Prompt: das Etikett im Bild vergrößern oder näher fotografieren.');
  }

  console.log('\nZUSTAND');
  console.log(`  Stufe        : ${analysis.condition}`);
  console.log(`  Sicherheit   : ${analysis.condition_confidence}`);
  console.log(`  woran erkannt: ${analysis.condition_evidence ?? '—'}`);

  console.log('\nARTIKEL');
  console.log(`  Marke        : ${analysis.brand ?? '—'} (${analysis.brand_confidence})`);
  console.log(`  Art          : ${analysis.type ?? '—'} (${analysis.type_confidence})`);
  console.log(`  Warengruppe  : ${analysis.category_group}`);
  console.log(`  Farben       : ${analysis.colors.join(', ') || '—'}`);

  if (analysis.notes.length) {
    console.log('\nANMERKUNGEN DES MODELLS');
    for (const note of analysis.notes) console.log(`  · ${note}`);
  }

  console.log('\nvollständige Antwort:\n');
  console.log(JSON.stringify(analysis, null, 2));
} catch (e) {
  console.error(`\n✗ ${e.name}: ${e.message}`);
  // Bei einem HTTP-Fehler steht die eigentliche Ursache im Body der API-Antwort.
  if (e.body) console.error('\nAntwort der API:\n' + e.body);
  process.exit(1);
}
