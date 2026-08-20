/**
 * Smoke test für lib/ai.js gegen die echte Anthropic-API.
 *
 * Prüft genau die zwei Stellen, die kein Unit-Test abdecken kann: ob die API das
 * erzwungene `tool_choice` zusammen mit adaptivem Denken akzeptiert, und ob das
 * `strict`-Schema so durchgeht, wie es gebaut ist.
 *
 * Braucht keinen Browser und kein Canvas — deshalb wird das Foto hier NICHT
 * heruntergerechnet. Nimm eine Datei unter ~4 MB.
 *
 *   ANTHROPIC_API_KEY=sk-ant-… node scripts/smoke-ai.mjs pfad/zum/foto.jpg [weitere.jpg …]
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
  images.push({ base64: bytes.toString('base64'), mediaType });
  console.log(`geladen: ${file} (${(bytes.length / 1e6).toFixed(2)} MB)`);
}

console.log(`\n→ ein Call mit ${images.length} Foto(s)…\n`);

try {
  const analysis = await analyse(images, {
    apiKey,
    settings: DEFAULT_SETTINGS,
    log: (event, data) => console.log(`  [${event}]`, JSON.stringify(data))
  });
  console.log('\n✓ Antwort geparst:\n');
  console.log(JSON.stringify(analysis, null, 2));
} catch (e) {
  console.error(`\n✗ ${e.name}: ${e.message}`);
  // Bei einem HTTP-Fehler steht die eigentliche Ursache im Body der API-Antwort.
  if (e.body) console.error('\nAntwort der API:\n' + e.body);
  process.exit(1);
}
