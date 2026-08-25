# ADR-0008 — Both pipelines run against a port, and the port checks arity

**Status:** accepted · **Date:** 2026-08-25 (v0.117.0) — written down retroactively. The
seam and its arity check arrived with `lib/relist-port.js` in v0.46.0; the second pipeline
got its own in v0.75.0.

## Context

Both pipelines end in an act that cannot be undone: `relist()` deletes a listing,
`publishDraft()` creates a public one. Their guarantees are therefore statements about
*paths not taken* — "the delete is never reached when anything upstream failed", "no field
in `needs_confirmation` reaches `createItem`".

A guarantee about a path not taken is only worth what its test is worth, and every effect
in these pipelines is unreachable from a test as written: HTTP calls that need a live
Vinted session, `chrome.storage`, cookies, the clock, UUIDs, `OffscreenCanvas`.

The usual answers are module mocking (`jest.mock` and friends) or a DI container. Neither
fits: there is no test framework here and no runtime dependencies (ADR-0006).

## Decision

Each pipeline takes **one** parameter that carries every effect it needs, defaulting to the
live adapter:

```js
export async function relist(url, port = livePort) { … }
export async function publishDraft(request, port = liveDraftPort) { … }
```

Three files per pipeline:

| | Relist | Auto-Listing |
|---|---|---|
| the interface, as data | `lib/relist-port.js` | `lib/draft-port.js` |
| the live adapter | `lib/live-port.js` | `lib/live-draft-port.js` |
| the fake | `tests/helpers/fake-port.js` | `tests/helpers/fake-draft-port.js` |

**The adapters hold no decisions.** Every member forwards to the module that owns that
behaviour, one line each. Anything with a judgement in it belongs behind the adapter (in
`lib/`) or in front of it (in the pipeline), never inside it — an adapter is the one file
in the seam that no test exercises directly.

**`missingMembers(port)` compares the parameter count, not just the name.** A conformance
test runs it against both the live adapter and the fake, so an adapter that grew a
parameter on one side and not the other fails in the suite instead of at a real article.
This is why the adapters spell their parameters out in full:

```js
uploadPhoto: (domain, auth, blob, filename, opts) => pageApi.uploadPhotoViaPage(domain, auth, blob, filename, opts),
```

No default values, no rest parameters — both would make `Function.length` lie.

## Consequences

- Every safety property is an ordinary assertion. `assert.equal(port.called('deleteItem'),
  false)` is the executable form of ADR-0002; `assert.equal(port.called('uploadPhoto'),
  false)` is the executable form of "a category we cannot fill stops the draft before the
  first upload".
- The fake records every call in order, so tests can assert *sequence* — that
  `uploadPhoto` precedes `createItem`, that `suggestCategories` precedes both.
- `relist.js` and `draft.js` are unit-tested without a browser, which is what keeps `lib/`
  at ~99 % line coverage while `popup/`, `studio/` and `content/` are deliberately not
  tested at all.
- Adding an effect to a pipeline is a four-file change: interface, live adapter, fake,
  caller. That friction is the point — it is a prompt to ask whether the effect belongs in
  the pipeline at all.
- The port is *not* a general dependency-injection mechanism. Pure modules (`crop.js`,
  `title.js`, `resolve.js`, `draft-view.js`, `item.js`) are imported directly and tested
  directly; they have no effects to inject.

## Do not re-suggest

**A mocking library or a DI container.** The seam is 40 lines of plain object per pipeline
and needs no machinery. A framework would add the first runtime dependency to a project
whose best property is not having any.

**Letting the adapters "just" add a default parameter.** It reads harmless and silently
disables the arity check for that member — which is exactly the check that caught a
forgotten `opts` argument before it reached a live upload.

**Passing individual functions instead of one port object.** It was tried; the call sites
grew a parameter list nobody could read, and the conformance check had nothing to check
against.
