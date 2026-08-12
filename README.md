# Vinted Relist – Chrome Extension

Löscht einen Vinted-Artikel und stellt ihn mit denselben Details + Fotos neu ein, damit er
in der Suche wieder ganz oben erscheint.

**Sicherheitsprinzip:** der Klon wird immer *zuerst* erstellt und verifiziert, das Original
erst danach gelöscht. Schlägt irgendetwas fehl, bleibt der Originalartikel unangetastet.

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

## Benutzung

Zwei Wege, beide mit identischem Verhalten:

**Auf der Seite:** In deinem Kleiderschrank erscheint auf jeder eigenen, aktiven
Artikelkarte ein **Relist**-Button neben Vinteds eigenem Bump-Button.

**Über das Popup:** Extension-Icon klicken → die URL des aktiven Tabs wird übernommen →
**Löschen & neu einstellen**.

Ablauf: Artikeldaten laden → Fotos herunterladen → re-encoden → hochladen → neuen Artikel
anlegen → verifizieren → erst dann den alten löschen.

**Test-Modus:** In den Einstellungen `Original löschen` ausschalten. Der Klon wird erstellt,
das Original bleibt. Der sichere Weg, um nach einem Update einmal alles durchzuspielen.

---

## Tech-Stack

Bewusst minimal — **keine Runtime-Dependencies, kein Bundler, kein Framework.**

| | |
|---|---|
| **Plattform** | Chrome Extension, Manifest V3 |
| **Sprache** | Vanilla JavaScript, ES2022, ES-Module |
| **Service Worker** | ESM (`background.type: "module"`) |
| **Popup** | ESM (`<script type="module">`) — importiert direkt aus `lib/` |
| **Content-Scripts** | klassische Skripte, teilen sich einen globalen Scope (siehe ADR-0006) |
| **Tests** | `node:test` + `node:assert/strict`, kein Test-Framework |
| **Coverage** | `node --experimental-test-coverage` |
| **Validierung** | eigenes Skript (`scripts/validate.mjs`), kein Linter-Setup |
| **Chrome-APIs** | `storage.local`, `tabs`, `scripting`, `cookies`, `webRequest`, `runtime` |
| **Bild-Verarbeitung** | `OffscreenCanvas` im Service Worker |
| **Node** | ≥ 18 (für `Blob`, `FormData`, `atob` in den Tests) |

`package.json` hat **keine** `dependencies` und **keine** `devDependencies`.

---

## Architektur

### Die drei Kontexte

```
┌──────────────────┐   relist/preflight    ┌────────────────────────┐
│  popup/popup.js  │──────relist/run──────▶│ background/            │
│  (ES-Modul)      │◀──── gates, message ──│  service-worker.js     │
└──────────────────┘                       │  (Router, keine Logik) │
                                           └───────────┬────────────┘
┌──────────────────┐   relist/preflight                │
│ content/         │──────relist/run──────────────────▶│ lib/relist.js
│  content.js      │◀──── gates, message ──────────────┤  (Pipeline)
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

### Das Wichtigste: die Pipeline hat eine Naht

`lib/relist.js` erzeugt seine Abhängigkeiten nicht selbst. Jeder Effekt — HTTP, Storage,
Cookies, Uhr, UUIDs — läuft über **einen** Parameter, den `RelistPort`:

```js
export async function relist(url, port = livePort) { … }
```

Zwei Adapter erfüllen dieses Interface:

- `lib/live-port.js` — der echte (page-api + image-utils + chrome.storage)
- `tests/helpers/fake-port.js` — in-memory, protokolliert jeden Aufruf

Deshalb sind alle Sicherheitsentscheidungen testbar. Jeder Fehlerpfad-Test prüft
`countOf('deleteItem') === 0` — das ist die ausführbare Form von
[ADR-0002](docs/adr/0002-create-then-delete.md).

`lib/relist-port.js` deklariert das Interface als Daten; ein Conformance-Test hält beide
Adapter in Sync.

### Eine Quelle für alle Warnungen

`lib/gates.js` entscheidet, **welche** Warnungen der Nutzer sieht, in welcher Reihenfolge,
mit welchem Text — und wie das Ergebnis heißt. Popup und Toast *rendern* nur. Vorher hatte
jede UI ihre eigene Kopie dieser Regeln, und die waren schon auseinandergelaufen.

Die Gates reisen über die vorhandene `relist/preflight`-Nachricht, weil ein
manifest-deklariertes Content-Script keine ES-Module importieren kann.

### Module

**`lib/` — Service-Worker-Seite (ESM)**

| Datei | Aufgabe |
|---|---|
| `relist.js` | Die Pipeline. Single-Flight, Verify-Gate, Ownership-Gate, Farb-Auto-Retry |
| `relist-port.js` | Deklaration der Naht (`PORT_MEMBERS`, `missingMembers`) |
| `live-port.js` | Der echte Adapter — reines Verdrahten |
| `gates.js` | **Pur.** Warnungen + Ergebnistexte für beide UIs |
| `item.js` | **Pur.** URL-Parsing, Create-Payload, Feld-Alias-Helfer |
| `page-api.js` | Alle Vinted-HTTP-Aufrufe, über das Content-Script |
| `auth.js` | CSRF/anon-id: webRequest-Snooping, Cookies, HTML-Scrape als Notnagel |
| `retry.js` | Backoff für 429, 5xx, `NetworkError`; injizierbares `sleep` |
| `errors.js` | `ApiError`, `RateLimitError`, `AuthError`, `NetworkError`, `BusyError`, `ValidationError` |
| `image-utils.js` | Foto-Download + Re-Encoding (`OffscreenCanvas`) |
| `settings.js` | Defaults + `chrome.storage.local` |
| `history.js` | Relist-Verlauf, rollende 1h/24h-Zähler |
| `confirmation.js` | Das „schon einmal bestätigt"-Flag |
| `progress.js` | `{pct, label}` in Storage; beide UIs abonnieren via `onChanged` |
| `logger.js` | 500-Zeilen-Ringpuffer — die Grundlage jeder Fehlersuche |
| `util.js` | `sleep`, `jitter`, `uuidV4`, `arrayBufferToBase64` |
| `domains.js` | Die 20 Vinted-Länderdomains, Match-Patterns |

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

**`background/service-worker.js`** — bewusst dünn: webRequest-Token-Snooper + Message-Router.
Keine Geschäftslogik.

### Nachrichtenprotokoll

| Nachricht | Richtung | Antwort |
|---|---|---|
| `relist/preflight` | UI → SW | `{ title, photoCount, interest, counts, gates }` |
| `relist/run` | UI → SW | `{ ok, …result, message }` |
| `relist/confirmed` | UI → SW | `{ ok }` |
| `api/call` | SW → Content | `{ ok, status, contentType, body, warnings }` |

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
- jede JS-Datei parst (`node --check`, parallel)
- jeder relative Import zeigt auf eine existierende Datei — auch in `popup/popup.js`, das
  hier nicht importiert werden kann, weil es beim Laden das DOM anfasst
- **kein Content-Script benutzt `import`/`export`** (würde beim Laden hart brechen)
- der ESM-Importgraph von `lib/` + `background/` lädt sauber unter Node

Aktuell: **265 Tests**, `lib/` bei ~99 % Line-Coverage.

Nicht unit-getestet und bewusst so: `image-utils.reencode` (braucht `OffscreenCanvas`) und
die beiden UI-Dateien. Nach jeder UI-Änderung einmal im Browser im Test-Modus durchklicken.

**Versionierung:** bei jeder Code-Änderung die Minor-Version in `package.json` *und*
`manifest.json` erhöhen. Nur so ist im Log (`start {"v":…}`) erkennbar, welcher Stand
tatsächlich geladen war.

**Fehlersuche:** `DEBUG.md` enthält Copy-Paste-Rezepte für die Service-Worker-Konsole. Der
Knopf „Log & Fehler kopieren" im Popup liefert Version + URL + Status + Log.

---

## Dokumentation

| | |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | Domain-Glossar: *relist*, *gate*, *partial*, *upload session*, … |
| [`docs/adr/`](docs/adr/) | Architekturentscheidungen — **vor Umbauten lesen** |
| [`DEBUG.md`](DEBUG.md) | DevTools-Rezepte |
| [`docs/TECHNISCHE_DOKUMENTATION.md`](docs/TECHNISCHE_DOKUMENTATION.md) | Ausführliche technische Doku |
| [`docs/ABLAUFDIAGRAMM.md`](docs/ABLAUFDIAGRAMM.md) | Ablaufdiagramme |

Die ADRs haben jeweils einen Abschnitt **„Do not re-suggest"** — sie existieren, damit
Entscheidungen mit Grund nicht immer wieder aufgerollt werden:

| ADR | Entscheidung |
|---|---|
| [0001](docs/adr/0001-route-api-calls-through-the-content-script.md) | API-Calls über das Content-Script (SW-`fetch` = 403) |
| [0002](docs/adr/0002-create-then-delete.md) | Erst erstellen, dann löschen — nie umgekehrt |
| [0003](docs/adr/0003-no-page-side-token-scraping.md) | Tokens nur aus dem Service Worker |
| [0004](docs/adr/0004-tolerate-vinted-field-renames.md) | Alias-Helfer + Shape-Logging für Vinteds Feld-Umbenennungen |
| [0005](docs/adr/0005-never-guess-condition-or-size.md) | Farbe wird gedefaultet, Zustand und Größe **nie** |
| [0006](docs/adr/0006-content-scripts-are-classic-scripts.md) | Content-Scripts teilen Globals, kein Bundler |

---

## Bekannte Risiken

- **Vinteds ToS verbietet Automatisierung.** Nutze die Extension sparsam und nicht in
  großer Stückzahl. Der Cooldown-Hinweis warnt ab 5 Relists/Stunde bzw. 30/24 h.
- **Vinted ändert interne API-Feldnamen jederzeit.** Genau das ist mehrfach passiert
  (Farbe, dann Zustand + Größe, dann Buch-Sprache). Wenn das Erstellen fehlschlägt, sagt
  die Fehlermeldung, ob *dein Artikel* ein Feld braucht oder ob *wir* ein Feld nicht lesen
  konnten — im zweiten Fall stehen im Log die Zeilen `create_rejected_probe` und
  `fetchItem_shape` mit den echten Shapes. → ADR-0004
- **Ein Relist verliert Favoriten, Aufrufe und Gespräche.** Deshalb gibt es das
  Interest-Gate.
- **Ein fehlgeschlagener Lauf kann zwei Artikel hinterlassen** (Status *partial*). Das ist
  der bewusste Tausch: ein Duplikat ist ärgerlich, eine Löschung ist unwiederbringlich.
- **Es wird nichts an einen externen Server gesendet** — alle Anfragen laufen direkt aus
  deinem Browser an Vinted. Der Log bleibt lokal in `chrome.storage.local`.
