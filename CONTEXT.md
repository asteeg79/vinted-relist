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

## Progress

**Phase** — one named stretch of a pipeline run: „Fotos übertragen", „Original löschen".
The phases of both pipelines live in `lib/steps.js`, each with the percentage mark at which
it begins. Never "step" in German copy — a *Schritt* is a step through the category tree.

**Phasenliste** — the whole list with each phase marked `done`, `current` or `todo`.
Derived from the percentage alone, because every phase already reports at a fixed,
ascending mark. A phase counts as done only once the NEXT one has started, or the running
one would show as ticked off while it works.

**Laufende Meldung** (`step` in the progress record) — the one sentence next to the bar
(„Foto 2/5: hochladen…"). Finer-grained than a phase, and always about right now.

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

**Objektbox** — das Rechteck, in dem der Artikel auf einem Foto liegt, inklusive
Sicherheitsrand. Zwei Quellen: die **Abschälung** (`objectBox`, schält Hintergrund von außen
nach innen weg) und die **Artikelbox** des Modells (`article_box`, normiert auf den Rahmen,
den es gesehen hat). Nie „Bounding Box".

**Artikelbox** — die Box, die die Erkennung selbst um den Artikel gezeichnet hat. Sie ist
das Einzige, was die Füße des Fotografen von einem Ärmel unterscheiden kann: der Abschälung
sind beide gleich viel Objekt. `modelBoxVerdict` prüft sie und sagt bei einer Absage, warum
— `malformed`, `outside`, `not_a_box`, `too_small`, `in_padding`, oder `full_frame`, was
keine Absage ist, sondern „der Artikel füllt das Bild ohnehin".

**Rahmen** — der 4:5-Ausschnitt, der aus einem Foto wird. Ein Rahmen schneidet nie in die
Objektbox; passt keiner um sie herum, wird stattdessen gefüllt.

**Padding** — das Auffüllen fehlender Bildfläche auf Hintergrundfarbe, statt das Objekt
zu beschneiden. Der sichere Ausgang jedes Zweifelsfalls.

**edges** — die vier Fakten, auf welchen Seiten der Artikel aus dem Bild läuft, seitenweise
und **vor** Sicherheitsrand und Clamp erhoben. Danach ist die Auskunft weg: ein `x` von 0
heißt sowohl „der Artikel beginnt in Spalte 0" als auch „der Rand hätte nach links gereicht,
das Bild aber nicht". Nur das Erste darf die Zentrierung verhindern.

**touchesEdge** — die Behauptung „der Artikel wurde schon beim Fotografieren
angeschnitten". Verwandt mit `edges`, aber nicht dasselbe: `edges` ist Geometrie. Bei der
Abschälung fallen beide zusammen; für die Artikelbox bleibt die Behauptung dem
`cropped_off`-Urteil des Modells vorbehalten.

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

**Blocker** — der Satz, der sagt, warum ein Feld nicht `ok` ist. Jeder Blocker gehört zu
einem Feld, das man ändern kann; eine Blocker-Zeile ohne Feld ist keine Prüfung, sondern
eine Wand. `blockers` beantwortet „was fehlt noch" — ein bereits eingestellter Draft steht
deshalb nicht darin, obwohl er sperrt (dafür gibt es `done`).

**Auflösung** — aus einem Wort wird Vinteds ID: „Hoodie" → `catalog_id 1806`. Sie liegt
unter dem Namen, den `resolve.js` vergibt (`catalog`, `brand`, `size`, `color`), nicht unter
dem Feldnamen des Studios. Ein Feld ohne Auflösung hat kein Recht auf die ID der vorigen.

**Kandidat** — ein Eintrag der Auswahlliste unter einem Feld. Zwei Sorten, und sie zu
verwechseln wäre eine Falschaussage: ein **Treffer** trägt eine ID und beendet die Frage,
ein **Schritt** trägt einen Pfad und ist die nächste Eingabe (so geht man durch Vinteds
Kategoriebaum). `candidateKind` sagt, welche Sorte eine Liste enthält.

**Gegenprobe** — vor dem Create wird Vinteds eigene Fotoerkennung befragt und mit dem
Draft verglichen (Entscheidung C). Widerspricht sie, wird das Feld geleert und beide
Antworten werden angeboten. **Ausnahme:** eine ausdrückliche Wahl des Nutzers steht
(`overriddenBy` sagt dann, wen er überstimmt hat) — sonst wäre die eigene Antwort nicht
durchsetzbar.

**Attributbeutel** (`item_attributes`) — die Liste kategorieabhängiger Angaben in der
Payload, etwa `language_book`. Er entsteht im Feldzustand, nicht in der Pipeline; und die
Vorabprüfung „verlangt diese Kategorie etwas, das wir nicht liefern können?" hält einen
Code nur dann für beantwortet, wenn er in genau diesem Beutel auch mitgeht.

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

**ISBN** — auf jedem Buchrücken mit Bindestrichen gedruckt, von Vinted nur als Ziffernfolge
angenommen. `normaliseIsbn` putzt sie; das ist dieselbe Nummer, nur lesbar gesetzt. Was
danach keine ISBN ist, blockiert am Feld statt beim Create.

**Buchsprache** (`language_book`) — ein Attribut, dessen IDs Vinted nirgends preisgibt.
Jede in `book.js` stammt aus einem von Hand eingestellten Inserat. Was dort nicht steht,
wird nicht geraten: eine falsche Sprache fällt niemandem auf, bis ein Käufer ein englisches
Buch auspackt.
