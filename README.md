# Vinted Relist – Chrome Extension

Zwei Werkzeuge für denselben Kleiderschrank, in einer Erweiterung:

**Relist** — löscht einen Vinted-Artikel und stellt ihn mit denselben Details und Fotos neu
ein, damit er in der Suche wieder ganz oben erscheint.

**Auto-Listing** — macht aus ein paar Handyfotos ein fertiges Inserat: zuschneiden,
erkennen, Felder auflösen, veröffentlichen. Der Nutzer bestätigt, was unsicher ist.

**Sicherheitsprinzip Relist:** der Klon wird immer *zuerst* erstellt und verifiziert, das
Original erst danach gelöscht. Schlägt irgendetwas fehl, bleibt das Original unangetastet.

**Sicherheitsprinzip Auto-Listing:** kein Feld geht ungefragt raus. Was das Modell unsicher
erkannt hat, blockiert das Veröffentlichen, bis ein Mensch es bestätigt — und was sich
nicht messen lässt, wird nicht geraten.

---

## Inhalt

- [Installation](#installation)
- [Benutzung](#benutzung)
- [Tech-Stack](#tech-stack)
- [Architektur](#architektur)
- [Entwicklung](#entwicklung)
- [Dokumentation](#dokumentation)
- [Bekannte Risiken](#bekannte-risiken)

---

## Installation

Kein Build-Schritt, keine Abhängigkeiten — der Quellcode ist das, was läuft.

1. Öffne `chrome://extensions`
2. Aktiviere oben rechts **Entwicklermodus**
3. Klicke **Entpackte Erweiterung laden**
4. Wähle den Ordner `vinted_extention/`

Nach jeder Code-Änderung: ⟳ klicken **und** den Vinted-Tab neu laden. Ob der Reload
gegriffen hat, verrät die Versionsnummer — sie steht in beiden Oberflächen.

Für das Auto-Listing zusätzlich: im Popup unter **Einstellungen** einen
Anthropic-API-Key hinterlegen. Er wird verschlüsselt abgelegt (PBKDF2 + AES-GCM); im
Klartext liegt er nur in `chrome.storage.session`, also bis zum Schließen des Browsers.

## Benutzung

### Relist

Zwei Wege, beide mit identischem Verhalten:

**Auf der Seite:** In deinem Kleiderschrank erscheint auf jeder eigenen, aktiven
Artikelkarte ein **Relist**-Button neben Vinteds eigenem Bump-Button.

**Über das Popup:** Extension-Icon klicken → die URL des aktiven Tabs wird übernommen →
**Löschen & neu einstellen**.

Ablauf: Anmeldung prüfen → Artikeldaten laden → Fotos herunterladen, neu kodieren,
hochladen → neuen Artikel anlegen → prüfen → erst dann das Original löschen. Der Toast auf
der Seite zeigt die Phasenliste mit, sodass jederzeit sichtbar ist, was schon passiert ist
und was noch kommt.

**Test-Modus:** In den Einstellungen `Original löschen` ausschalten. Der Klon wird erstellt,
das Original bleibt. Der sichere Weg, um nach einem Update einmal alles durchzuspielen.

### Auto-Listing

Popup → **Neuen Artikel aus Fotos erstellen**. Das Studio öffnet sich in einem eigenen Tab.

1. **Fotos hineinziehen.** Jedes wird zweimal aufbereitet: die Inseratskopie (4:5,
   höchstens 1080×1350) und die Modellkopie — das *ganze* Foto, ungeschnitten, denn die
   Erkennung soll sehen, was da ist, und nicht unsere Vermutung davon.
2. **Ein Erkennungs-Call** über alle Fotos zusammen: Marke, Art, Größe, Zustand, Farben,
   Material, Beschreibung, Fotoreihenfolge — und je Foto die Artikelbox.
3. **Zweiter Zuschnitt** anhand dieser Box, immer aus der Originaldatei. So verschwinden
   die Füße des Fotografen aus dem Titelbild.
4. **Felder auflösen:** aus „Hoodie" wird Vinteds Kategorie-ID, aus „M" die Größen-ID.
   Passt ein Wort nirgends, steht die Auswahl darunter — oder man tippt ein anderes.
5. **Bestätigen, was unsicher ist.** Jedes Feld ist `ok`, `bestätigen` oder `fehlt`; der
   Knopf zum Veröffentlichen bleibt gesperrt, solange etwas offen ist.
6. **Veröffentlichen.** Fotos hoch, Gegenprobe bei Vinteds eigener Fotoerkennung, dann der
   Create.

**Trockenlauf ist der Standard** (`draftCreateEnabled: false`): Der Lauf geht bis zur
fertigen Payload, die ins Log wandert, und sendet nichts. Scharf geschaltet wird von Hand,
und beide Oberflächen sagen jederzeit, welcher Modus gilt.

---

## Tech-Stack

Bewusst minimal — **keine Runtime-Dependencies, kein Bundler, kein Framework.**

| | |
|---|---|
| **Plattform** | Chrome Extension, Manifest V3 |
| **Sprache** | Vanilla JavaScript, ES2022, ES-Module |
| **Service Worker** | ESM (`background.type: "module"`) |
| **Popup / Studio** | ESM (`<script type="module">`) — importieren direkt aus `lib/` |
| **Content-Scripts** | klassische Skripte, teilen sich einen globalen Scope (ADR-0006) |
| **Tests** | `node:test` + `node:assert/strict`, kein Test-Framework |
| **Coverage** | `node --experimental-test-coverage` |
| **Validierung** | eigenes Skript (`scripts/validate.mjs`), kein Linter-Setup |
| **Chrome-APIs** | `storage.local`, `storage.session`, `tabs`, `scripting`, `cookies`, `webRequest`, `runtime` |
| **Bild-Verarbeitung** | `OffscreenCanvas` (Relist, im SW) und DOM-Canvas (Studio, im Tab) |
| **KI** | `api.anthropic.com`, Tool-Use mit JSON-Schema — Aufruf **nur** aus dem Studio-Tab |
| **Node** | ≥ 18 für die Tests (`Blob`, `FormData`, `atob`) |

`package.json` hat **keine** `dependencies` und **keine** `devDependencies`.

---

## Architektur

### Die vier Kontexte

```
┌──────────────────┐   relist/preflight    ┌────────────────────────┐
│  popup/popup.js  │──────relist/run──────▶│ background/            │
│  (ES-Modul)      │◀──── gates, message ──│  service-worker.js     │
└──────────────────┘                       │  (Router, keine Logik) │
                                           │                        │
┌──────────────────┐   draft/gates         │  ├─ lib/relist.js      │
│  studio/studio.js│──────draft/publish───▶│  └─ lib/draft.js       │
│  (eigener Tab)   │◀──── gates, message ──│                        │
└────────┬─────────┘                       └───────────┬────────────┘
         │ fetch (der Key bleibt hier)                 │
         ▼                                             │
  api.anthropic.com                                    │
                                                       │
┌──────────────────┐   relist/preflight                │
│ content/         │──────relist/run──────────────────▶│
│  content.js      │◀──── gates, message ──────────────┤
│  page-call.js    │                                   │
│  card-policy.js  │◀───── api/call ───────────────────┘ lib/page-api.js
└────────┬─────────┘
         │ fetch() mit echtem Origin + Cookies
         ▼
    api.vinted.de
```

**Warum der Umweg über das Content-Script?** Vinted lehnt state-changing Requests ab,
deren `Origin` keine echte `vinted.*`-Seite ist. Ein `fetch()` aus dem Service Worker
sendet `Origin: chrome-extension://…` und bekommt **403**. Also packt der SW jeden Request
in eine `api/call`-Nachricht, das Content-Script führt ihn im Seitenkontext aus.
→ [ADR-0001](docs/adr/0001-route-api-calls-through-the-content-script.md)

**Nur die schreibende Hälfte überquert diese Naht.** Vom Auto-Listing bleiben Zuschnitt,
KI-Call und Feldbestätigung im Studio-Tab; der Worker bekommt einen Aufruf und gibt eine
Antwort, statt minutenlang zu leben (er hat rund 30 Sekunden). Lesende Vinted-Calls gehen
laut Addendum zu ADR-0001 auch direkt aus einer Extension-Page, sofern die Header stimmen.

### Das Wichtigste: die Pipelines haben eine Naht

Weder `lib/relist.js` noch `lib/draft.js` erzeugt seine Abhängigkeiten selbst. Jeder Effekt
— HTTP, Storage, Cookies, Uhr, UUIDs — läuft über **einen** Parameter, den Port:

```js
export async function relist(url, port = livePort) { … }
export async function publishDraft(request, port = liveDraftPort) { … }
```

Je zwei Adapter erfüllen diese Interfaces:

- `lib/live-port.js` / `lib/live-draft-port.js` — die echten (page-api + chrome.storage)
- `tests/helpers/fake-port.js` / `fake-draft-port.js` — in-memory, protokollieren jeden Aufruf

Deshalb sind alle Sicherheitsentscheidungen testbar. Jeder Fehlerpfad-Test prüft
`countOf('deleteItem') === 0` — das ist die ausführbare Form von
[ADR-0002](docs/adr/0002-create-then-delete.md).

`lib/relist-port.js` und `lib/draft-port.js` deklarieren die Interfaces als Daten;
`missingMembers()` vergleicht **auch die Stelligkeit**, damit ein Adapter mit vergessenem
Parameter im Test auffällt und nicht erst am echten Artikel. Deshalb schreiben die Adapter
ihre Parameter vollständig aus, ohne Defaults und ohne Rest.

### Eine Quelle für alle Entscheidungen

**Warnungen und Ergebnistexte:** `lib/gates.js` entscheidet, *welche* Warnungen der Nutzer
sieht, in welcher Reihenfolge, mit welchem Text — und wie das Ergebnis heißt. Popup, Toast
und Studio *rendern* nur. Vorher hatte jede UI ihre eigene Kopie dieser Regeln, und die
waren schon auseinandergelaufen.

**Feldzustände:** `lib/draft-view.js` ist das Gegenstück fürs Auto-Listing. Es entscheidet
je Feld `ok` / `needs_confirmation` / `missing`, formuliert den Grund, führt die
Kandidatenlisten und gibt `canPublish` frei. Das Studio zeichnet.

Zwei Regeln, die daraus folgen und im Code mehrfach zitiert werden:

- **Jede Sperre hängt an einem Feld.** Eine Blocker-Zeile, zu der es kein Feld gibt, das man
  ändern könnte, ist keine Prüfung, sondern eine Wand.
- **Nie eine ID raten** ([ADR-0005](docs/adr/0005-never-guess-condition-or-size.md)): wo
  eine Kategorie-, Größen-, Farb- oder Sprach-ID nicht gemessen werden kann, steht `null`
  und der Lauf hält an — bevor das erste Foto hochgeht.

Die Gates und die Phasenliste reisen über die vorhandenen Nachrichten bzw. über
`chrome.storage`, weil ein manifest-deklariertes Content-Script keine ES-Module importieren
kann.

### Module

**`lib/` — gemeinsam genutzt**

| Datei | Aufgabe |
|---|---|
| `domains.js` | Die 20 Vinted-Länderdomains, Match-Patterns, Sprache je Host |
| `util.js` | `sleep`, `jitter`, `uuidV4`, `arrayBufferToBase64`, `base64ToBytes` |
| `errors.js` | `ApiError`, `RateLimitError`, `AuthError`, `NetworkError`, `BusyError`, `ValidationError` |
| `item.js` | **Pur.** URL-Parsing, beide Create-Payloads, Feld-Alias-Helfer, Vinteds Feldfehler in Sätze |
| `settings.js` | Defaults + `chrome.storage.local` |
| `history.js` | Verlauf, rollende 1h/24h-Zähler |
| `progress.js` | `{pct, step, steps}` in Storage; alle Oberflächen abonnieren via `onChanged` |
| `steps.js` | **Pur.** Die Phasen beider Pipelines + `stepsAt()` + die Zeichen `✓ ▸ ·` |
| `gates.js` | **Pur.** Warnungen + Ergebnistexte für alle Oberflächen |
| `confirmation.js` | Die „schon einmal bestätigt"-Flags (Löschen, erstes Anlegen) |
| `logger.js` | 500-Zeilen-Ringpuffer — die Grundlage jeder Fehlersuche. `log` **wirft nie** |
| `auth.js` | CSRF/anon-id: webRequest-Snooping, Cookies, HTML-Scrape als Notnagel |
| `vinted-read.js` | Lesender Transport aus einer Extension-Page, inklusive abgelaufener Sitzung |
| `page-api.js` | Alle schreibenden Vinted-HTTP-Aufrufe, über das Content-Script |
| `image-utils.js` | Foto-Download, base64→Blob, Re-Encoding (`OffscreenCanvas`) |
| `retry.js` | Backoff für 429, 5xx, `NetworkError`; injizierbares `sleep` |
| `write-lock.js` | „Ein schreibender Vorgang" — geteilt von beiden Pipelines |

**`lib/` — Relist-Pipeline**

| Datei | Aufgabe |
|---|---|
| `relist.js` | Die Pipeline. Single-Flight, Verify-Gate, Ownership-Gate, Farb-Auto-Retry |
| `relist-port.js` | Deklaration der Naht (`PORT_MEMBERS`, `missingMembers`) |
| `live-port.js` | Der echte Adapter — reines Verdrahten |

**`lib/` — Auto-Listing (zweite Pipeline, ADR-0007)**

| Datei | Aufgabe |
|---|---|
| `crop.js` | **Pur.** Objektbox, Rahmenwahl, Padding, Pad-Farbe — das Objekt wird nie angeschnitten. `modelBoxVerdict` prüft die Artikelbox der KI und rechnet sie ins Original zurück; `edges` sagt seitenweise, wo der Artikel aus dem Bild läuft |
| `title.js` | **Pur.** Titelbau je Profil, Kürzungsreihenfolge, Byte-Limit |
| `resolve.js` | **Pur.** String → Vinted-ID; Nutzerwahl; die Gegenprobe (`crossCheck`) |
| `condition.js` | **Pur.** Vinteds fünf Zustandsstufen: Vokabular, Zuordnung zur `status_id`, Vorauswahl |
| `book.js` | **Pur.** Gemessene `language_book`-IDs, die Auswahl fürs Feld, die ISBN-Form |
| `price.js` | **Pur.** Vinteds `midpoint`, Rundung, Untergrenze, Schutz des manuellen Preises |
| `price-memory.js` | Was du zuletzt für Vergleichbares genommen hast — Hinweis, kein Vorschlag |
| `draft-view.js` | **Pur.** Render-Modell des Studios: Feldzustände, Blocker, Titel, `canPublish`, der Attributbeutel |
| `ai.js` | Anthropic-Client: ein Erkennungs-Call je Artikel, Tool-Use mit JSON-Schema |
| `secret.js` | API-Key verschlüsselt (PBKDF2 + AES-GCM), Klartext nur in `storage.session` |
| `taxonomy.js` | Kategorien, Marken, Farben, Größen, Zustände, Preisspanne — **Transport injiziert**, mit TTL-Cache |
| `lookup.js` | Die Vorbereitung: Erkennung → IDs → Preis. Lesend, ohne Lock |
| `draft.js` | Die Veröffentlichungs-Pipeline gegen den `DraftPort` |
| `draft-port.js` | Deklaration der Naht (`DRAFT_PORT_MEMBERS`, `missingMembers`) |
| `live-draft-port.js` | Der echte Adapter — reines Verdrahten |

**`studio/` — die vierte Oberfläche (eigener Tab, ES-Modul)**

| Datei | Aufgabe |
|---|---|
| `studio.js` | Intake, Review, Veröffentlichen, Zurücksetzen — **enthält keine Entscheidung** |
| `canvas.js` | Canvas-Adapter: EXIF aufrichten, zuschneiden bzw. füllen, JPEG kodieren. Zwei Ausgaben aus **einem** Rahmen: die Inseratsdatei (bis 1080×1350) und die Modellkopie (das ganze Foto, bis 1568). `prepare(file, { box })` zeichnet für den zweiten Durchgang neu — mit der bereits entschiedenen Box, immer aus dem Original |
| `klar.css` | Theme-Layer (siehe unten) |

`studio/*` ist neben `popup/*` und `content/*` bewusst nicht unit-getestet — deshalb liegt
jede Entscheidung in `lib/`. Nach jeder UI-Änderung einmal im Trockenlauf durchklicken.

**`content/` — Seiten-Seite (klassische Skripte, Reihenfolge zählt)**

| Datei | Aufgabe |
|---|---|
| `page-call.js` | `VintedPageCall.buildInit` — `api/call`-Nachricht → `fetch`-Argumente |
| `card-policy.js` | `VintedCardPolicy.relistability` — welche Karten einen Button bekommen |
| `content.js` | API-Proxy + Relist-Buttons + Toast/Dialoge |

Keine dieser Dateien enthält `import`/`export`. Das ist erzwungen (`npm run validate`) und
hat einen Nebeneffekt: eine Datei ohne Modul-Syntax ist gleichzeitig ein gültiges klassisches
Skript *und* ein gültiges ES-Modul — die Tests importieren sie für ihren globalen
Seiteneffekt. Deshalb braucht es keinen Bundler.
→ [ADR-0006](docs/adr/0006-content-scripts-are-classic-scripts.md)

Was das Content-Script **nicht** importieren kann, muss ihm zugereicht werden: die Gates
über `relist/preflight`, die Phasenliste über den Fortschritts-Datensatz. Die eine
unvermeidliche Abschrift — die Zeichen der Phasenliste — hält ein Test in
`tests/steps.test.js` gegen `lib/steps.js`.

**`background/service-worker.js`** — bewusst dünn: webRequest-Token-Snooper +
Message-Router. Keine Geschäftslogik.

### Die Oberflächen: ein additiver Theme-Layer

Alle drei Oberflächen tragen dieselbe Richtung („Klar"), und zwar als **zusätzliches**
Blatt: `content/klar.css`, `popup/klar.css`, `studio/klar.css` werden jeweils nach dem
Basis-Stylesheet geladen und überschreiben nur Erscheinung, keine Struktur. Zum Zurückrollen
genügt es, das Blatt zu entfernen.

Drei Regeln: weiße Flächen ohne Radien; Teal als Kopfband und **die eine** primäre Aktion;
Status als 3-px-Kante links plus getönte Fläche. Rot bleibt Fehlern vorbehalten — der
Bestätigen-Knopf vor dem Löschen ist Tinte, weil unumkehrbar nicht dasselbe ist wie „etwas
ist schiefgegangen". `content/klar.css` liegt in einer *fremden* Seite: jede Regel ist auf
`.vr-*` verankert, `:root` bleibt unangetastet.

### Nachrichtenprotokoll

| Nachricht | Richtung | Antwort |
|---|---|---|
| `relist/preflight` | Popup/Content → SW | `{ ok, title, photoCount, interest, counts, gates, steps }` |
| `relist/run` | Popup/Content → SW | `{ ok, …result, message }` |
| `relist/confirmed` | Popup/Content → SW | `{ ok }` |
| `draft/gates` | Studio → SW | `{ ok, gates }` |
| `draft/publish` | Studio → SW | `{ ok, …result, message }` |
| `draft/confirmed` | Studio → SW | `{ ok }` |
| `api/call` | SW → Content | `{ ok, status, contentType, body, warnings }` |

Fortschritt fließt **nicht** per Message, sondern über `chrome.storage.local.progress` —
so überlebt er ein geschlossenes Popup.

---

## Entwicklung

```bash
npm run check      # validate + alle Tests (das ist die ganze Toolchain)
npm test           # nur Tests
npm run coverage   # mit Coverage-Report
npm run validate   # nur die statischen Checks
```

`npm run validate` prüft:

- `manifest.json` ist gültiges MV3 und alle referenzierten Dateien existieren
- jede JS-Datei parst (`node --check`, parallel) — auch `popup/*` und `studio/*`
- jeder relative Import zeigt auf eine existierende Datei
- **kein Content-Script benutzt `import`/`export`** (würde beim Laden hart brechen)
- der ESM-Importgraph von `lib/` + `background/` lädt sauber unter Node

Aktuell: **868 Tests**, `lib/` bei ~99 % Line-Coverage.

### Der Ordner wächst, nicht die Extension

Die Erweiterung wird **entpackt** geladen: Chrome zeigt in `chrome://extensions` die Größe
des *ganzen Projektordners* an — Tests, Doku und `.git` inklusive. Die eigentliche
Extension sind rund 480 KB in 54 Dateien. Zweimal ist der Ordner dadurch unbemerkt
angeschwollen, beide Male aus einem Grund, den man nicht sieht:

**`npm run coverage`, nicht `npx c8`.** Der Skriptweg nutzt die eingebaute Abdeckung von
`node:test` und schreibt nichts auf die Platte. `c8` legt pro Lauf V8-Rohdaten in
`coverage/tmp/` ab und räumt sie nie weg — nach ein paar Läufen sind das 16 MB. Dass der
Ordner in `.gitignore` steht, hilft nicht: Chrome liest das Verzeichnis, nicht das
Repository. Aufräumen: `rm -rf coverage`.

**Gelegentlich `git gc`.** Git legt jede Version jeder geänderten Datei zunächst
**vollständig** ab und komprimiert erst beim Packen — automatisch aber erst ab 6700 losen
Objekten, was hier nie erreicht wird. Nach 13 Commits waren es 420 lose Objekte mit
2,6 MB; gepackt sind daraus 483 KB geworden, Faktor 5,6. Ein Aufruf nach ein paar größeren
Commits genügt:

```bash
git gc          # verliert nichts Erreichbares; hier die einzige nötige Wartung
du -sh .        # zur Kontrolle
```

Und `.DS_Store` löschen, wenn macOS wieder eines angelegt hat — aus demselben Grund wie
oben: es steht in `.gitignore`, liegt aber im Ordner.

Nicht unit-getestet und bewusst so: `popup/`, `studio/`, `content/` (dort wird nichts
entschieden), sowie `image-utils.reencode` und `studio/canvas.js` (beide brauchen ein
echtes Canvas). Nach jeder UI-Änderung einmal im Browser im Test-Modus bzw. Trockenlauf
durchklicken.

**Versionierung:** bei jeder Code-Änderung die Minor-Version in `package.json` *und*
`manifest.json` erhöhen. Sie steht in beiden Oberflächen und im Log (`publish_start
{"v":…}`) — nach einem „bitte neu laden" ist sie die einzige Auskunft darüber, ob das
geschehen ist.

**Fehlersuche:** [`DEBUG.md`](DEBUG.md) enthält Copy-Paste-Rezepte für die
Service-Worker-Konsole. Der Knopf „Log & Fehler kopieren" im Popup liefert Version + URL +
Status + Log.

---

## Dokumentation

| | |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | Domain-Glossar: *relist*, *gate*, *partial*, *Feldzustand*, *Gegenprobe*, … |
| [`docs/adr/`](docs/adr/) | Architekturentscheidungen — **vor Umbauten lesen** |
| [`DEBUG.md`](DEBUG.md) | DevTools-Rezepte |
| [`docs/TECHNISCHE_DOKUMENTATION.md`](docs/TECHNISCHE_DOKUMENTATION.md) | Ausführliche technische Doku, inklusive der gemessenen Vinted-API |
| [`docs/ABLAUFDIAGRAMM.md`](docs/ABLAUFDIAGRAMM.md) | Ablaufdiagramme beider Pipelines |
| [`docs/KONZEPT_AUTO_LISTING.md`](docs/KONZEPT_AUTO_LISTING.md) | Auto-Listing: das Konzept und die Entscheidungen dahinter |
| [`docs/IMPLEMENTIERUNGSPLAN_AUTO_LISTING.md`](docs/IMPLEMENTIERUNGSPLAN_AUTO_LISTING.md) | Auto-Listing: der abgearbeitete Bauplan (Historie) |

Die ADRs haben jeweils einen Abschnitt **„Do not re-suggest"** — sie existieren, damit
Entscheidungen mit Grund nicht immer wieder aufgerollt werden:

| ADR | Entscheidung |
|---|---|
| [0001](docs/adr/0001-route-api-calls-through-the-content-script.md) | Schreibende API-Calls über das Content-Script (SW-`fetch` = 403); lesende dürfen direkt |
| [0002](docs/adr/0002-create-then-delete.md) | Erst erstellen, dann löschen — nie umgekehrt |
| [0003](docs/adr/0003-no-page-side-token-scraping.md) | Tokens nur aus dem Service Worker |
| [0004](docs/adr/0004-tolerate-vinted-field-renames.md) | Alias-Helfer + Shape-Logging für Vinteds Feld-Umbenennungen |
| [0005](docs/adr/0005-never-guess-condition-or-size.md) | Farbe wird gedefaultet, Zustand/Größe/Kategorie/Sprache **nie** |
| [0006](docs/adr/0006-content-scripts-are-classic-scripts.md) | Content-Scripts teilen Globals, kein Bundler |
| [0007](docs/adr/0007-auto-listing-second-pipeline.md) | Auto-Listing als zweite Pipeline in derselben Extension |
| [0008](docs/adr/0008-pipelines-run-against-a-port.md) | Beide Pipelines laufen gegen einen Port, inklusive Stelligkeitsprüfung |

---

## Bekannte Risiken

- **Vinteds ToS verbietet Automatisierung.** Nutze die Extension sparsam und nicht in
  großer Stückzahl. Der Cooldown-Hinweis warnt ab 5 Relists/Stunde bzw. 30/24 h.
- **Vinted ändert interne API-Feldnamen jederzeit.** Genau das ist mehrfach passiert
  (Farbe, dann Zustand + Größe, dann Buch-Sprache, dann die ISBN). Wenn das Erstellen
  fehlschlägt, sagt die Fehlermeldung, ob *dein Artikel* ein Feld braucht oder ob *wir* ein
  Feld nicht lesen konnten — im zweiten Fall stehen im Log die Zeilen
  `create_rejected_probe` und `fetchItem_shape` mit den echten Shapes. → ADR-0004
- **Ein Relist verliert Favoriten, Aufrufe und Gespräche.** Deshalb gibt es das
  Interest-Gate.
- **Ein fehlgeschlagener Relist kann zwei Artikel hinterlassen** (Status *partial*). Das ist
  der bewusste Tausch: ein Duplikat ist ärgerlich, eine Löschung ist unwiederbringlich. Beim
  Auto-Listing gibt es kein Partial — ohne Artikel ist nichts entstanden.
- **Die Erkennung kostet Geld.** Ein Anthropic-Call je Artikel, über alle Fotos zusammen.
  Ein zweiter Durchgang für den Zuschnitt kostet keinen weiteren Call.
- **Was ein Modell erkennt, ist ein Vorschlag.** Deshalb blockiert jedes unsichere Feld,
  deshalb fragt das Auto-Listing zusätzlich Vinteds eigene Fotoerkennung als Gegenprobe, und
  deshalb ist der Trockenlauf der Standard.
- **Es wird nichts an einen fremden Server gesendet, außer an Anthropic** — und das nur die
  Fotos, nur aus dem Studio-Tab, nur mit deinem eigenen Key. Alle Vinted-Anfragen laufen
  direkt aus deinem Browser. Das Log bleibt lokal in `chrome.storage.local`.
