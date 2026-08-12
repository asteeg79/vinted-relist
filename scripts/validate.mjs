import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import process from 'node:process';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let fail = 0;
function ok(msg) { console.log(`  [32m✓[0m ${msg}`); }
function err(msg) { console.log(`  [31m✗[0m ${msg}`); fail++; }
function section(t) { console.log(`\n[1m${t}[0m`); }

// ---- manifest.json ----
section('manifest.json');
const manifestPath = path.join(root, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  ok('valid JSON');
} catch (e) {
  err('invalid JSON: ' + e.message);
}

if (manifest) {
  if (manifest.manifest_version === 3) ok('MV3'); else err(`manifest_version=${manifest.manifest_version}, expected 3`);
  if (manifest.background?.service_worker) ok(`service_worker: ${manifest.background.service_worker}`); else err('no background.service_worker');
  if (manifest.background?.type === 'module') ok('service worker is ES module'); else err('background.type must be "module" (ESM imports used)');
  if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.length) ok(`${manifest.host_permissions.length} host_permissions`); else err('no host_permissions');
  if (manifest.action?.default_popup) ok(`popup: ${manifest.action.default_popup}`); else err('no action.default_popup');

  // Verify all file references exist
  const refs = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...(manifest.content_scripts || []).flatMap(cs => cs.js || []),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ].filter(Boolean);

  for (const ref of refs) {
    try {
      await readFile(path.join(root, ref));
      ok(`exists: ${ref}`);
    } catch {
      err(`missing referenced file: ${ref}`);
    }
  }
}

// ---- JS syntax check ----
section('JS syntax');
const jsFiles = [];
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) jsFiles.push(p);
  }
}
await walk(root);

// Read each file once here; the sections below reuse these sources.
// `node --check` spawns a subprocess per file, so run them concurrently.
const sources = new Map(await Promise.all(
  jsFiles.map(async file => [file, await readFile(file, 'utf8')])
));
const syntax = await Promise.all(jsFiles.map(async file => {
  // Undefined globals like `chrome` are fine — --check only parses.
  try {
    await exec(process.execPath, ['--check', file]);
    return null;
  } catch (e) {
    return `syntax error in ${path.relative(root, file)}: ${e.stderr || e.message}`;
  }
}));
syntax.forEach((problem, i) => problem ? err(problem) : ok(`syntax: ${path.relative(root, jsFiles[i])}`));

// ---- Relative imports resolve ----
// Covers every JS file, including popup/popup.js, which is an ES module but can't be
// imported here (it touches the DOM at load). A broken specifier there would silently
// break the whole popup, so check the paths statically.
section('relative imports resolve');
for (const file of jsFiles) {
  const rel = path.relative(root, file);
  const specifiers = [...sources.get(file).matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]);
  for (const spec of specifiers) {
    const target = path.resolve(path.dirname(file), spec);
    try {
      await readFile(target);
      ok(`${rel} → ${spec}`);
    } catch {
      err(`${rel} imports missing file: ${spec}`);
    }
  }
}

// ---- Content scripts must not be ES modules ----
// A content script declared in the manifest is loaded as a classic script — an `import`
// statement is a hard syntax error at load. This is why gate decisions reach the toast
// over a message instead of an import (see lib/gates.js).
section('content scripts are not ES modules');
for (const cs of (manifest?.content_scripts || []).flatMap(c => c.js || [])) {
  const src = sources.get(path.join(root, cs)) ?? await readFile(path.join(root, cs), 'utf8');
  if (/(?:^|\n)\s*(?:import\s|export\s)/.test(src)) {
    err(`${cs} uses import/export — manifest-declared content scripts cannot be ES modules`);
  } else {
    ok(`${cs} has no import/export`);
  }
}

// ---- ESM import graph (lib + background) ----
section('ESM import resolution (lib/ + background/)');
// Discovered, not hardcoded, so a new lib module is never silently left unchecked.
const esmEntry = [
  'background/service-worker.js',
  ...(await readdir(path.join(root, 'lib'))).filter(f => f.endsWith('.js')).sort().map(f => `lib/${f}`)
];
// Stub the chrome.* + DOM globals the modules touch at import time, so they load cleanly under node.
globalThis.chrome = {
  runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: '0.0.0' }) },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  cookies: { get: (_q, cb) => cb && cb(null) },
  tabs: { query: async () => [] },
  scripting: { executeScript: async () => [] },
  webRequest: { onBeforeSendHeaders: { addListener: () => {} } }
};
globalThis.OffscreenCanvas = class { constructor() {} getContext() { return { drawImage(){} }; } convertToBlob() { return Promise.resolve(new Blob()); } };
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

for (const f of esmEntry) {
  try {
    await import(path.join(root, f));
    ok(`imports: ${f}`);
  } catch (e) {
    err(`import failed for ${f}: ${e.message}`);
  }
}

console.log();
if (fail) {
  console.log(`[31m${fail} problem(s)[0m`);
  process.exit(1);
} else {
  console.log('[32mall checks passed[0m');
}
