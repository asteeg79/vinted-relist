# ADR-0006 — Content scripts share globals; no bundler

**Status:** accepted · **Date:** 2026-08-12 (v0.42.0)

## Context

A content script declared in `manifest.json` is loaded as a classic script. `import` and
`export` are syntax errors there. That blocks the content script from reusing anything in
`lib/`, which is why gate decisions and outcome messages had been duplicated into it.

The usual answers are a bundler (esbuild/rollup) or an ESM injection shim.

## Decision

Neither. Shared page-side code lives in additional files listed in `content_scripts.js`,
which share a global scope:

- `content/page-call.js` → `globalThis.VintedPageCall`
- `content/card-policy.js` → `globalThis.VintedCardPolicy`

Each defines its global inside an IIFE and contains **no import/export at all**. That has a
useful second property: a file with no module syntax is simultaneously a valid classic
script and a valid ES module, so tests `import` it purely for the side effect and then read
the global. No build step, and the page-side logic is still unit-tested.

Decisions the content script cannot compute locally (gates, outcome messages) travel over
the existing `relist/preflight` and `relist/run` messages instead of being duplicated.

## Consequences

- File order in `manifest.json` matters: a file must appear before the one that uses its
  global. `lib/page-api.js` keeps `CONTENT_SCRIPTS` in the same order for auto-injection.
- `scripts/validate.mjs` fails the build if any content script gains an import or export.
- The project stays dependency-free with no build step; `npm run check` is the whole
  toolchain.

## Do not re-suggest

Adding a bundler to let content scripts import `lib/`. It would buy tidier imports at the
cost of the project's only genuinely nice property — that the source you edit is the source
that runs.
