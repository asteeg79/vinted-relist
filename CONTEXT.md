# Domain model — Vinted Relist

The vocabulary this codebase uses. Terms are used exactly as defined here in code,
comments, log events and tests; if a name changes, it changes everywhere at once.

Architectural vocabulary (module, interface, seam, adapter, depth) is separate — see the
`codebase-design` skill. This file is only about the problem domain.

## The core act

**Relist** — delete a Vinted listing and immediately recreate it from the same data, so it
reappears at the top of search. Vinted ranks newer listings higher; doing this by hand is
the trick the extension automates. Never "repost", "bump" or "refresh" in code — though
the on-page button is labelled *Relist* and the user-facing German copy says *Bump*.

**Source item** (`src`) — the original listing being relisted, as returned by
`GET /api/v2/item_upload/items/{id}`. Its field names are Vinted's, not ours, and they
change without notice (see ADR-0004).

**Clone** — the new listing created from the source item. Only ever called a clone before
the original is deleted; afterwards it is simply the listing.

**Pipeline** — the ordered run of steps that turns a source item into a clone and then
removes the original. Lives in `lib/relist.js`. Exactly one may be in flight at a time.

**Preflight** — the non-destructive read that happens before the user commits: it fetches
the source item, reads its interest and the relist counts, and returns the gates. A
preflight never writes anything and is never blocked by a running pipeline.

## Outcomes

A pipeline run ends in exactly one of these. They are distinct because the user's next
action differs in each case.

**Success** — clone created and verified, original deleted.

**Test mode** — clone created, original deliberately kept, because `deleteEnabled` is off.
The safe way to try a risky change.

**Partial** — clone created but the original was NOT deleted: verification failed, the
ownership check failed, or the delete call failed. The user has two live listings and must
resolve it by hand. Never call this a failure — something was created.

**Failure** — nothing was created; the original is untouched. Always the safe outcome.

## Gates

**Gate** — a confirmation the user must clear before the destructive pipeline runs.
Computed in `lib/gates.js`, rendered by both UIs, decided by neither. A gate carries
`{ kind, title, text, lines, note, remember }`.

- **First-run gate** — explains that the original is permanently deleted. The only gate
  whose acceptance is remembered (`remember: true`).
- **Cooldown gate** — warns when the rolling relist counts cross the configured
  thresholds. Vinted's anti-bot heuristics look for patterns; this is pacing, not a limit.
- **Interest gate** — warns that favourites, views and conversations are lost when a
  listing is recreated.

**Interest** — the engagement a listing has accumulated: favourites, views, conversations.
Destroyed by a relist, which is the whole reason the interest gate exists.

**Cooldown counts** — relists in the last rolling hour and 24 hours, from the history.

## Auto-Listing

Die Begriffe der zweiten Pipeline (ADR-0007, `docs/KONZEPT_AUTO_LISTING.md`) stehen hier
in der Sprache, in der sie im Studio erscheinen. Sie werden in Code, Kommentaren,
Log-Events und Tests exakt so verwendet wie hier definiert.

**Draft** — ein in Vorbereitung befindliches neues Inserat: zugeschnittene Fotos,
erkannte Felder, gebauter Titel, Beschreibung, Preis. Ein Draft existiert nur lokal;
er wird zu einem Listing, wenn er veröffentlicht wird. Nie „Entwurf", nie „Listing",
solange er nicht veröffentlicht ist.

**Studio** — die Extension-Page (`studio/`), in der Drafts entstehen: Foto-Intake,
Zuschnitt, KI-Erkennung, Review. Ein eigener Tab, nicht das Popup. Das Studio trifft
keine Entscheidungen; es rendert das Modell aus `lib/draft-view.js`.

**Vorbereitung** — alles am Draft, was Vinted nicht oder nur lesend berührt: Zuschnitt,
Erkennung, Textbau, Taxonomie-Lookups. Läuft frei, auch parallel zu einem Relist.

**Veröffentlichen** — die schreibende Phase: Foto-Upload plus Create. Nimmt dasselbe
Lock wie `relist()`. Nie „posten", nie „einstellen" im Code.

**Objektbox** — das Rechteck, in dem `crop.js` den fotografierten Artikel vermutet,
inklusive Sicherheitsrand. Nie „Bounding Box".

**Rahmen** — der 4:5-Ausschnitt, der aus einem Foto wird. Ein Rahmen schneidet nie in die
Objektbox; passt keiner um sie herum, wird stattdessen gepaddet.

**Padding** — das Auffüllen fehlender Bildfläche auf Hintergrundfarbe, statt das Objekt
zu beschneiden. Der sichere Ausgang jedes Zweifelsfalls.

**Profil** — der Satz Titel-Slots einer Warengruppe (`clothing`, `shoes`, `accessories`,
`media`, `generic`), mit Pflicht-Slots und Kürzungsreihenfolge. Für Kleidung: Marke, Art,
Größe, Farbe — Größe ist Pflicht.

**Titelbild** — das erste Foto eines Drafts. Vinted zeigt es in der Trefferliste, es
entscheidet mit, ob überhaupt jemand klickt. Die KI schlägt die Reihenfolge vor, der
Nutzer sortiert per Ziehen um; anders als ein Feldzustand blockiert ein suboptimales
Titelbild nichts.

**Feldzustand** — je Draft-Feld einer von `ok`, `needs_confirmation`, `missing`.
Veröffentlichen ist erst freigegeben, wenn kein Feld mehr in den letzten beiden Zuständen
ist. Ein vorbelegter Wert (etwa Zustand „Sehr gut") ist bis zur Bestätigung
`needs_confirmation`, nicht `ok`.

**Trockenlauf** — `draftCreateEnabled: false`: Der Draft läuft bis zur fertigen Payload,
die ins Log geht; der Create unterbleibt. Das Gegenstück zum Testmodus beim Relist.

### Ausgänge eines Veröffentlichungsversuchs

**Erfolg** — Fotos hochgeladen, Artikel erstellt.

**Trockenlauf** — Payload gebaut und geloggt, nichts gesendet, weil `draftCreateEnabled`
aus ist.

**Fehler** — nichts ist entstanden. Auch dann, wenn Fotos bereits hochgeladen waren: Die
Upload-Session wird nicht wiederverwendet, ein neuer Versuch lädt mit frischer
`temp_uuid` neu hoch. Anders als beim Relist gibt es hier **kein Partial** — ohne Artikel
ist nichts entstanden, das der Nutzer von Hand auflösen müsste.

## Session and identity

**Auth bundle** — `{ csrf, anonId, vUdt, vUid }`, everything needed to make a
state-changing Vinted call. Assembled by `ensureAuth`.

**Live tokens** — CSRF and anon-id captured off the Vinted SPA's own requests by the
service worker's webRequest listener. The freshest source, and the primary one.

**Session** — the per-domain auth bundle persisted from a previous run, used as a warm
start. A null field never overwrites a stored one (ADR-0003).

**Upload session** — the UUID that binds re-uploaded photos to the create call. Every
photo in one relist and the create payload must carry the same value or Vinted rejects
the photos. Not related to the user's login session.

## Item fields

**Condition** (`status_id` in the payload) — the item's wear state, shown to buyers.
Vinted has moved this field between shapes; read it with `conditionId()`, never directly.

**Size** (`size_id`) — same, via `sizeId()`. As of 2026-08-12 there is no top-level size
field at all and it may live inside `item_attributes`.

Neither is ever defaulted or guessed — see ADR-0005.

**Colour** — the one field that IS auto-defaulted, to a neutral value, when a category
requires one and the source has none.
