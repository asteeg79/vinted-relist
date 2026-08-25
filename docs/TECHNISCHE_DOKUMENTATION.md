# Technische Dokumentation — Vinted Relist

**Stand: v0.117.0 · 2026-08-25 · 868 Tests**

Chrome-Extension (Manifest V3) mit **zwei Pipelines**:

- **Relist** — einen bestehenden Vinted-Artikel automatisiert löschen und neu einstellen
  („bump"), um ihn in der Suche wieder nach oben zu bringen.
- **Auto-Listing** — aus Fotos ein neues Inserat bauen: zuschneiden, erkennen, Felder gegen
  Vinteds Listen auflösen, veröffentlichen.

Beide arbeiten ausschließlich in der bestehenden Browser-Session des Nutzers.

> **Diese Datei beschreibt den Ist-Stand.** Sie ist die einzige Stelle, an der Vinteds
> undokumentierte API festgehalten ist (§6) — jeder Befund darin ist gemessen, mit Datum.
>
> Wer wissen will, *warum* etwas so entschieden wurde, liest die
> [ADRs](./adr/) und [KONZEPT_AUTO_LISTING.md](./KONZEPT_AUTO_LISTING.md); die sind
> Entscheidungsprotokolle und werden nicht rückwirkend geglättet, sondern mit Nachträgen
> versehen, wo die Wirklichkeit sie korrigiert hat.
>
> Die Abläufe stehen als Diagramme im [Ablaufdiagramm](./ABLAUFDIAGRAMM.md), der Einstieg
> in [README.md](../README.md), die Begriffe in [CONTEXT.md](../CONTEXT.md).

> **Ein Prinzip, präzisiert:** „kein Backend, keine gespeicherten Zugangsdaten" gilt seit
> dem Auto-Listing (ADR-0007) in der Fassung *„keine gespeicherten **Vinted**-Zugangsdaten,
> kein Backend im Vinted-Pfad"*. Der eigene Anthropic-Key liegt verschlüsselt im
> Extension-Storage; sein Verlust kostet Geld, nicht den Account.

---

## 1. Inhaltsverzeichnis

2. Überblick & Designprinzipien
3. Verzeichnis- & Modulstruktur
4. Laufzeit-Kontexte und Kommunikation
5. Authentifizierung (CSRF, anon_id, Cookies)
6. Vinted-API-Referenz
7. Die Pipelines im Detail (Relist + Auto-Listing)
8. Speicher (chrome.storage.local)
9. Einstellungen
10. Sicherheitsnetze
11. Build, Validierung & Tests
12. Bekannte Grenzen & Wartung
13. ToS-Hinweis

---

## 2. Überblick & Designprinzipien

- **Manifest V3**, Service Worker als ES-Modul.
- **Modulare Architektur:** reine Logik (testbar) ist von chrome.*-I/O getrennt; der
  Service Worker ist nur ein dünner Message-Router.
- **Entscheidungen in `lib/`, Oberflächen rendern nur.** Popup, Studio und Content-Script
  enthalten keine Regel, die man nicht in einem Test festhalten könnte — sie zeichnen, was
  `lib/` ihnen sagt. Deshalb sind `popup/`, `studio/` und `content/` bewusst **nicht**
  unit-getestet: was dort noch entschieden würde, gehört eine Ebene tiefer.
- **Port/Adapter:** Beide Pipelines laufen gegen eine Schnittstelle (`relist-port.js`,
  `draft-port.js`) — live gegen `live-port.js` / `live-draft-port.js`, im Test gegen einen
  Fake. `missingMembers()` vergleicht dabei auch die **Stelligkeit**, damit ein Adapter mit
  vergessenem Parameter im Test auffällt und nicht erst am echten Artikel. Deshalb
  deklarieren die Adapter ihre Parameter vollständig, ohne Defaults und ohne Rest.
- **create-then-delete:** Der neue Artikel wird immer zuerst erstellt (und optional
  verifiziert), das Original erst danach gelöscht.
- **Origin-Treue:** State-changing API-Calls laufen im Page-Kontext eines echten
  Vinted-Tabs (Content-Script), damit Vintends CSRF-/Origin-Prüfung sie akzeptiert
  ([ADR-0001](./adr/0001-route-api-calls-through-the-content-script.md)); **lesende** Calls
  gehen laut Addendum auch direkt aus einer Extension-Page, sofern die Header stimmen.
- **Keine geratene ID** ([ADR-0005](./adr/0005-never-guess-condition-or-size.md)): Wo eine Kategorie-,
  Größen- oder Farb-ID nicht gemessen werden kann, steht `null` und der Lauf hält an. Eine
  plausible falsche ID fällt niemandem auf, bis der Käufer auspackt.
- **Anti-Bot-Hygiene:** sequentielle Calls mit Jitter, Foto-Re-Encoding gegen
  Duplikat-Erkennung, Cooldown-Warnungen.

---

## 3. Verzeichnis- & Modulstruktur

```
vinted_extention/
├── manifest.json              MV3-Manifest (Permissions, Entry Points, Domains)
├── background/
│   └── service-worker.js      Dünner Koordinator: webRequest-Snooper + Message-Router
├── content/
│   ├── page-call.js           fetch im Page-Kontext (ADR-0001), klassisches Skript
│   ├── card-policy.js         wo in der Wardrobe ein Relist-Button hin darf
│   ├── content.js             (1) API-Proxy  (2) Wardrobe-Enhancer (Relist-Button+Toast)
│   ├── inject.css             Struktur der injizierten UI (vr-* Klassen)
│   └── klar.css               Theme-Layer „Klar" — additiv, NACH inject.css geladen
├── popup/
│   ├── popup.html/.css/.js    Popup-UI: URL, Warnungen, Fortschritt, Verlauf, Settings
│   └── klar.css               derselbe Theme-Layer für das Popup
├── studio/                    Auto-Listing-Oberfläche (ADR-0007), eigener Tab
│   ├── studio.html/.css/.js   Fotos → Zuschnitt → Erkennung → Felder → Veröffentlichen
│   ├── canvas.js              Zuschnitt im DOM-Canvas (Listing-Bild + Modell-Kopie)
│   └── klar.css               derselbe Theme-Layer fürs Studio
├── lib/                       Geschäftslogik (ES-Module)
│   ├── domains.js             Vinted-Hostliste + Match-Patterns + isVintedHost()
│   ├── util.js                sleep, jitter, uuidV4, arrayBufferToBase64
│   ├── errors.js              AuthError, ApiError, RateLimitError, ValidationError, …
│   ├── item.js                parseUrl, buildItemUploadPayload, Validierungsfehler lesen
│   ├── settings.js            DEFAULT_SETTINGS, get/save/reset
│   ├── history.js             Verlauf + getCounts (1 h / 24 h)
│   ├── progress.js            setProgress/clearProgress (storage)
│   ├── steps.js               Phasenlisten beider Pipelines + stepsAt()
│   ├── logger.js              log/clearLog (500-Zeilen Ring-Buffer)
│   ├── gates.js               Gates & Meldungstexte für BEIDE Oberflächen
│   ├── confirmation.js        Erst-Bestätigung (Löschen / erstes Anlegen)
│   ├── auth.js                Token-Snooping, CSRF-Scrape, Sessions, ensureAuth
│   ├── vinted-read.js         lesender fetch aus einer Extension-Page (+ 401-Behandlung)
│   ├── page-api.js            schreibende API-Calls via Content-Script
│   ├── image-utils.js         fetchAsBlob, base64ToBlob, reencode (OffscreenCanvas)
│   ├── retry.js               withRetry (Backoff für 429/5xx)
│   ├── write-lock.js          nur EIN Schreiblauf gleichzeitig
│   ├── relist-port.js         Schnittstelle der Relist-Pipeline (+ Stelligkeitsprüfung)
│   ├── live-port.js           Live-Adapter dazu
│   ├── relist.js              Relist-Pipeline: relist() + preflight()
│   │
│   ├── ai.js                  Anthropic-Call: Foto → erkannte Felder (Tool-Schema)
│   ├── secret.js              API-Key verschlüsselt ablegen/entsperren
│   ├── crop.js                Artikelbox, Rahmenwahl, Zuschnitt-Urteil (rein)
│   ├── taxonomy.js            Kategorien/Größen/Preisvorschlag, gecacht
│   ├── lookup.js              Erkanntes → Vinted-IDs auflösen
│   ├── resolve.js             Auflösung, Nutzerwahl, Gegenprobe (Entscheidung C)
│   ├── condition.js           Zustandsvokabular + status_id (eine Heimat)
│   ├── book.js                gemessene `language_book`-IDs (Medien-Profil)
│   ├── title.js               Titel bauen, Profile, Pflichtfelder
│   ├── price.js               Preisfindung + Untergrenze
│   ├── price-memory.js        gemerkte Preise je Kategorie
│   ├── draft-view.js          der Feldzustand: ok / needs_confirmation / missing
│   ├── draft-port.js          Schnittstelle der Publish-Pipeline
│   ├── live-draft-port.js     Live-Adapter dazu
│   └── draft.js               Publish-Pipeline: publishDraft()
├── scripts/
│   ├── validate.mjs           Manifest-/Syntax-/ESM-Import-Checks
│   ├── capture-vinted.js      Messhilfe: echte SPA-Calls mitschneiden
│   └── smoke-ai.mjs           ein echter Anthropic-Call gegen ein Foto
├── tests/                     node:test Suite (+ chrome-mock/Fake-Port Helper)
└── docs/                      diese Doku, Ablaufdiagramm, Konzept, ADRs
```

### Modul-Verantwortlichkeiten (Kurzreferenz)

**Gemeinsam genutzt**

| Modul | Exporte (Auswahl) | Zweck |
|---|---|---|
| `domains.js` | `VINTED_HOSTS`, `tabMatchPatterns`, `apiMatchPatterns`, `apiHostFor`, `isVintedHost` | Single Source of Truth für Domains |
| `util.js` | `sleep`, `jitter`, `uuidV4`, `arrayBufferToBase64`, `base64ToBytes` | Reine Helfer |
| `errors.js` | `AuthError`, `ApiError`, `RateLimitError`, `NetworkError`, `BusyError`, `ValidationError` | Typisierte Fehler für Branching |
| `item.js` | `parseUrl`, `buildItemUploadPayload`, `buildNewItemPayload`, `extractInterest`, `validationErrorsOf`, `describeValidationErrors` | Reine Daten-Transformationen |
| `settings.js` | `DEFAULT_SETTINGS`, `SETTINGS_KEY`, `getSettings`, `saveSettings`, `resetSettings` | Persistente Einstellungen |
| `history.js` | `getHistory`, `addEntry`, `clearHistory`, `getCounts` | Verlauf + Cooldown-Zähler |
| `progress.js` | `PROGRESS_KEY`, `setProgress`, `clearProgress` | Fortschritt publizieren |
| `steps.js` | `RELIST_STEPS`, `DRAFT_STEPS`, `stepsAt` | Phasen: was war, was kommt |
| `gates.js` | `gatesFor`, `draftGatesFor`, `describeOutcome`, `describeDraftOutcome`, `describeFailure` | Warnungen & Ergebnistexte — eine Heimat für beide UIs |
| `confirmation.js` | `hasConfirmedDelete/Create`, `setConfirmedDelete/Create` | Einmalige Erst-Bestätigung |
| `logger.js` | `log`, `clearLog` | Diagnose-Log — `log` **wirft nie** (siehe §10) |
| `auth.js` | `extractTokensFromHeaders`, `saveLiveTokens`, `saveSession`, `readCookies`, `fetchCsrfFromHtml`, `ensureAuth` | Auth-Beschaffung |
| `vinted-read.js` | `readHeaders`, `createVintedFetch`, `SESSION_EXPIRED` | Lesende Calls + abgelaufene Sitzung |
| `page-api.js` | `fetchItemViaPage`, `uploadPhotoViaPage`, `createItemViaPage`, `deleteItemViaPage`, `suggest*ViaPage` | Schreibende API über Content-Script |
| `image-utils.js` | `fetchAsBlob`, `base64ToBlob`, `reencode` | Foto-Download, -Dekodierung, Re-Encoding |
| `retry.js` | `withRetry` | Wiederholung bei 429/5xx |
| `write-lock.js` | `withWriteLock`, `currentWriter` | Ein Schreiblauf zur Zeit |

**Relist-Pipeline**

| Modul | Exporte (Auswahl) | Zweck |
|---|---|---|
| `relist-port.js` | `PORT_MEMBERS`, `missingMembers` | Schnittstelle + Stelligkeitsprüfung |
| `live-port.js` | `livePort` | Live-Verdrahtung (reine Weiterleitung) |
| `relist.js` | `relist`, `preflight` | Pipeline |

**Auto-Listing (ADR-0007)**

| Modul | Exporte (Auswahl) | Zweck |
|---|---|---|
| `ai.js` | `buildAnalysisRequest`, `parseAnalysis`, `analyse` | Der KI-Call und sein Tool-Schema |
| `secret.js` | `storeKey`, `unlockKey`, `cacheKey`, `describeKeyState` | API-Key verschlüsselt halten |
| `crop.js` | `objectBox`, `chooseFrame`, `boxFromModel`, `modelBoxVerdict`, `scaleBox` | Zuschnitt-Rechnung (rein) |
| `taxonomy.js` | `browseCatalogs`, `findCatalog`, `sizesFromGroups`, `parsePriceSuggestion`, `createTaxonomy` | Vinteds Kataloge, gecacht |
| `lookup.js` | `lookupDraft`, `applySuggestions` | Erkanntes → IDs |
| `resolve.js` | `resolveField`, `validatePick`, `crossCheck` | Auflösung, Nutzerwahl, Gegenprobe |
| `condition.js` | `CONDITIONS`, `conditionIdFor`, `conditionTitleFor`, `chooseCondition` | Zustand: ein Vokabular |
| `book.js` | `BOOK_LANGUAGES`, `BOOK_LANGUAGE_OPTIONS`, `chooseBookLanguage`, `bookLanguageAttributes`, `normaliseIsbn` | Gemessene Buchsprachen + die ISBN-Form |
| `title.js` | `profileFor`, `buildTitle`, `missingRequired` | Titel + Profil-Pflichtfelder |
| `price.js` / `price-memory.js` | `priceForDraft`, `recallPrice`, `savePrice` | Preis finden und merken |
| `draft-view.js` | `draftView`, `conflictedFields`, `FIELD_*` | Der Feldzustand — was blockiert und warum |
| `draft-port.js` / `live-draft-port.js` | `missingMembers`, `liveDraftPort` | Schnittstelle + Live-Verdrahtung |
| `draft.js` | `publishDraft` | Pipeline |

---

## 4. Laufzeit-Kontexte und Kommunikation

Vier isolierte JS-Kontexte:

1. **Service Worker** (`background/`): hat Zugriff auf privilegierte APIs
   (`chrome.cookies`, `chrome.webRequest`, `chrome.scripting`, `chrome.tabs`), kann aber
   nicht same-origin gegen Vinted fetchen.
2. **Content-Script** (`content/`): läuft im Vinted-Tab, kann same-origin fetchen, hat
   aber nur eingeschränkte chrome.* APIs.
3. **Popup** (`popup/`): die UI, lebt nur solange das Popup offen ist.
4. **Studio-Page** (`studio/`): eigener Tab für das Auto-Listing (ADR-0007). ES-Modul wie
   das Popup, importiert `lib/` direkt. Hier laufen Zuschnitt (DOM-Canvas) und die
   KI-Calls gegen `api.anthropic.com` — die Originalfotos verlassen den Tab nie, und der
   entschlüsselte API-Key auch nicht. Vinted-Calls laufen unverändert nur über das
   Content-Script (ADR-0001).

Das Content-Script ist ein **klassisches** Skript und kann keine Module importieren
([ADR-0006](./adr/0006-content-scripts-are-classic-scripts.md)) — alles, was es braucht,
muss ihm zugereicht werden. Das prägt zwei Entwürfe weiter unten (Fortschritt und Theme).

**Message-Protokoll** (`chrome.runtime.onMessage`):

| Typ | Von → Nach | Payload | Antwort |
|---|---|---|---|
| `relist/preflight` | Popup/Content → SW | `{url}` | `{ok, title, photoCount, interest, counts, gates, steps}` |
| `relist/run` | Popup/Content → SW | `{url}` | `{ok, ...result, message}` |
| `relist/confirmed` | Popup/Content → SW | `{}` | `{ok}` |
| `draft/gates` | Studio → SW | `{}` | `{ok, gates}` |
| `draft/publish` | Studio → SW | `{request}` | `{ok, ...result, message}` |
| `draft/confirmed` | Studio → SW | `{}` | `{ok}` |
| `api/call` | SW → Content | `{method, path, headers, json?\|multipart?}` | `{ok, status, contentType, body}` |

Beide UIs rendern die `gates` und die `message`, die der Router liefert, statt selbst zu
formulieren — siehe `lib/gates.js`.

### Fortschritt: eine Zahl, ein Satz, und die Phasenliste

Fortschritt fließt **nicht** per Message, sondern über `chrome.storage.local.progress`
(Publish/Subscribe): Popup und Toast hören via `chrome.storage.onChanged`. Der Datensatz
ist `{pct, step, steps, ts}`.

`steps` ist die Phasenliste aus `lib/steps.js` — was erledigt ist (`done`), was gerade
läuft (`current`), was noch aussteht (`todo`). Drei Entscheidungen dahinter:

- **Die Prozente reichen als Quelle.** Jede Phase meldet ohnehin an einer festen,
  aufsteigenden Marke an; aus `pct` allein lässt sich die Phase ableiten. Kein zweiter Wert
  durch die Pipelines, keine breitere Port-Schnittstelle — `publishProgress(pct, label)`
  behält seine zwei Parameter.
- **Erledigt ist eine Phase erst, wenn die NÄCHSTE begonnen hat.** Sonst stünde die
  laufende als abgehakt da, während sie arbeitet. Bei 100 % ist alles erledigt.
- **Die Liste reist im Datensatz mit.** Der *Adapter* wählt die **Tabelle**
  (`live-port.js` → `RELIST_STEPS`, `live-draft-port.js` → `DRAFT_STEPS`) — er ist die eine
  Stelle, die weiß, welche Pipeline läuft. Ausgerechnet wird die Liste in `setProgress`,
  **aus derselben gerundeten Zahl, die auch gespeichert wird**: vorher bekam `stepsAt` das
  ungerundete `pct`, und bei 74,6 stand `pct: 75` im Datensatz — genau auf der Marke der
  nächsten Phase —, während die Liste noch die vorige als laufend führte. Die Oberflächen
  zeichnen nur. Das ist nicht Bequemlichkeit, sondern ADR-0006: das Content-Script könnte
  `steps.js` gar nicht importieren, eine handgepflegte Kopie der Marken dort würde niemand
  prüfen. Damit die Liste schon vor der ersten Fortschrittsmeldung dasteht, liefert
  `relist/preflight` sie mit.

Das Zeichen (`✓` `▸` `·`) trägt die Aussage auch ohne Farbunterscheidung. Es steht als
`STEP_MARKS` in `lib/steps.js`, weil es eine Aussage über den Zustand ist und keine Frage
des Aussehens — „erledigt" sieht in beiden Fenstern gleich aus, oder es ist ein Fehler. Das
Popup importiert die Tabelle; das Content-Script kann das nicht und hält die einzige Kopie,
die ein Test in `tests/steps.test.js` gegen die Tabelle vergleicht.

### Die Oberflächen: ein additiver Theme-Layer

Alle drei Oberflächen tragen dieselbe Richtung („Klar"), und zwar als **zusätzliches**
Blatt: `content/klar.css`, `popup/klar.css`, `studio/klar.css` werden jeweils NACH dem
Basis-Stylesheet geladen und überschreiben nur Erscheinung, keine Struktur. Keine Zeile in
`inject.css`/`popup.css`/`studio.css` wurde dafür geändert; zum Zurückrollen genügt es, das
Blatt zu entfernen (beim Content-Script: den Eintrag in `manifest.json` →
`content_scripts[0].css`).

Die Richtung in drei Regeln: weiße Flächen ohne Radien; Teal als Kopfband und **die eine**
primäre Aktion; Status als 3-px-Kante links plus getönte Fläche. Rot bleibt Fehlern
vorbehalten — der Bestätigen-Knopf vor dem Löschen ist **Tinte**, weil unumkehrbar nicht
dasselbe ist wie „etwas ist schiefgegangen".

Eine Einschränkung gilt nur für `content/klar.css`: es liegt in einer **fremden** Seite.
Jede Regel ist deshalb auf `.vr-*` verankert und `:root` bleibt unangetastet — Vinteds
eigene Variablen gehören Vinted.

---

## 5. Authentifizierung

State-changing Calls brauchen zwei Header; die Session-Cookies (HttpOnly) schickt der
Browser automatisch mit (`credentials: 'include'`):

- **`X-CSRF-Token`** — UUID. Liegt **nicht** in einem JS-lesbaren Cookie und **nicht**
  in einem `<meta>`-Tag, sondern als `"CSRF_TOKEN":"<uuid>"` in einem Inline-`<script>`
  authentifizierter Seiten.
- **`X-Anon-Id`** — aus dem (JS-lesbaren) `anon_id`-Cookie.

`ensureAuth(domain, itemId)` beschafft beide aus mehreren Quellen (Reihenfolge =
Frische): **liveTokens** (vom webRequest-Snooper) → **gespeicherte Session** →
**HTML-Scrape** (`/items/{id}/edit`, `/items/new`, `/member/{vUid}`).

**Nicht** verwendet werden (obwohl im Cookie vorhanden): `Authorization: Bearer
access_token_web` und `X-V-Udt` — die echte SPA sendet sie auf den Item-Upload-Endpoints
nicht.

---

## 6. Vinted-API-Referenz

> Reverse-engineered, undokumentiert, kann sich ändern. Stand: 2026.

| Aktion | Methode | Pfad | Hinweise |
|---|---|---|---|
| Item lesen | `GET` | `/api/v2/item_upload/items/{id}` | Volles editierbares JSON (`status_id`, `color1_id`, `brand_id`, `photos`, …). Wrappt in `{item}`. |
| Foto hochladen | `POST` | `/api/v2/photos` | `multipart/form-data`: `photo[type]=item`, `photo[file]`, **`photo[temp_uuid]`**. Liefert `{id, temp_uuid}`. |
| Item erstellen | `POST` | `/api/v2/item_upload/items` | JSON-Payload (siehe unten). Header `X-Upload-Form: true`. Liefert `{item:{id}}`. |
| Item löschen | `POST` | `/api/v2/items/{id}/delete` | **Nicht** das DELETE-Verb. Legacy `DELETE /api/v2/items/{id}` → 404. |

**Create-Payload (validiert):**

```json
{
  "item": {
    "currency": "EUR",
    "temp_uuid": "<upload_session_uuid>",
    "title": "…", "description": "…",
    "brand_id": 407093, "brand": "LEGO Technic",
    "catalog_id": 1767, "isbn": null,
    "is_unisex": true, "ai_photo": false,
    "price": 7,
    "package_size_id": 2,
    "shipment_prices": { "domestic": null, "international": null },
    "color_ids": [17], "color1_id": 17, "color2_id": null,
    "assigned_photos": [{ "id": 26843512767, "orientation": 0 }],
    "status_id": 2,
    "size_id": 620
  },
  "upload_session_id": "<gleiche uuid wie item.temp_uuid>",
  "feedback_id": null, "push_up": false, "parcel": null
}
```

Wichtig:
- `assigned_photos` = Objekte `{id, orientation}` mit **Integer-IDs**, nicht UUID-Strings.
- `temp_uuid` (im Item) und top-level `upload_session_id` müssen **identisch** sein —
  Vinted bindet die hochgeladenen Fotos an diese Session.
- Foto-IDs sind session-gebunden: Foto-IDs des Original-Artikels werden beim Create
  abgelehnt (`error_uploading_photo`); deshalb werden Fotos **immer neu hochgeladen**.

### Endpoints für das Auto-Listing (Spike 0b, Prüfpunkte 1–2 — 2026-08-14)

Mitgeschnitten auf `/items/new`, alles `GET`/`POST` same-origin mit den Headern aus §5.
Antworten sind gekürzt auf die Felder, die wir brauchen; `code: 0` heißt überall „ok".

| Zweck | Methode | Pfad | Antwort |
|---|---|---|---|
| Kategoriebaum, vollständig | `GET` | `/api/v2/item_upload/catalogs` | `{catalogs, code}` — 486 KB, 2910 Knoten, 8 Wurzeln |
| Kategorie suchen | `GET` | `/api/v2/item_upload/catalogs/search?keyword=…` | `{catalog_ids: […], code}` — **nur IDs**, Namen aus dem Baum |
| ~~Pflichtfelder je Kategorie~~ | `GET` | `/api/v2/offline_verification/criteria/{catalog_id}` | `{required_field_codes: ["brand","price"], code}` — **konstant**, siehe Nachtrag 2026-08-21 |
| Attribute je Kategorie | `POST` | `/api/v2/item_upload/attributes` | Körper `{catalog_id, attributes: []}` → `{attributes: [{code, value_ids, value, configuration}], code}` |
| **Größen je Kategorie** | `GET` | `/api/v2/item_upload/size_groups?catalog_ids[]={id}` | `{size_groups: [{id, caption, description, size_ids, sizes: [{id, title, is_default, is_other, order}]}], code}` |
| **Zustände je Kategorie** | `GET` | `/api/v2/item_upload/conditions?catalog_id={id}` | `{conditions: [{id, title, explanation}], code}` |
| Zustände, allgemein | `GET` | `/api/v2/statuses` | `{statuses: [{id, title, description, explanation}], code}` |
| Marken je Kategorie | `GET` | `/api/v2/item_upload/brands?category_id={id}` | `{brands: [{id, title, requires_authenticity_check, is_luxury, is_hvf, has_children}], disable_custom_brands, code}` — 50 beliebte |
| Farben | `GET` | `/api/v2/item_upload/colors` | `{colors: [{id, title, hex, order, code}], code}` — 29 Stück |
| **Preisvorschlag** | `GET` | `/api/v2/item_price_suggestions?catalog_id=&brand_id=&status_id=` | siehe unten |
| Paketgrößen je Kategorie | `GET` | **`api.`**`vinted.<tld>/shipping-estimation/external/catalogs/{catalog_id}/package_sizes` | `{package_sizes: [{id, code: SMALL\|MEDIUM\|LARGE, title, …}]}` |
| Paketgröße vorschlagen | `POST` | **`api.`**`vinted.<tld>/shipping-estimation/external/package_sizes/suggestion` | `{package_size_id}` — anderer Host, **ohne** Auth-Header, siehe Nachtrag 2026-08-21 |
| Kategorie aus Fotos | `POST` | `/api/v2/item_upload/suggestions/categories` | `{categories: […], prefill_categories: […], legacy_first_category, code}` |
| Marke/Farbe aus Fotos | `POST` | `/api/v2/item_upload/suggestions/attributes` | `{brands, colors, sizes, isbn, dynamic_attributes, code}` |

Ein Kategorie-Knoten ist `{id, title, restricted_to_status_id, badge, photo, path, catalogs[]}`.
Blätter haben `catalogs: []`. Der Baum trägt **keine** Größengruppe — die hängt an der
Kategorie und wird einzeln geholt. Das ist die Reihenfolge aus §6.2 des Konzepts, von
Vinted selbst erzwungen: erst Kategorie, dann die dafür gültige Größenmenge.

**Nachtrag 2026-08-23 — die Größe braucht eine ID, und das Etikett trägt mehrere Systeme.**

Ein echtes Inserat scheiterte **nach** dem Foto-Upload:
`400 {"field":"size","value":"Wähle ein Größe, um fortzufahren"}`. Auf dem Bildschirm
stand `Größe=M[ok]`, im Kopf `größe=—`. Zwei Fehler übereinander:

1. **`splitOn` zerlegte nur Vinteds Seite.** Vinted schreibt „M / 38 / 10", und dafür war
   die Regel gedacht. Das Etikett trägt aber genauso oft mehrere Systeme: Under Armour
   näht „MD/M/M" ein, eine Jeans „38/40". Als Ganzes ist das nie eine Vinted-Größe, und
   ungetrennt fand es nichts. Jetzt werden beide Seiten zerlegt; treffen mehrere Teile
   mehrere Einträge, ist das eine Auswahl und keine Entscheidung.
2. **`NEEDS_ID` führte die Größe nicht.** Dort stand, sie sei „in der Payload nullbar" —
   Vinted sieht das anders. Ein Wort ohne ID sieht bei der Größe genauso gefüllt aus wie
   bei der Kategorie, stand auf `ok` und gab das Veröffentlichen frei. Die Prüfung greift
   nur, wo das Feld auch verlangt wird: Medien und Accessoires ändern sich nicht.

Dazu der Ausweg, ohne den die Sperre eine Sackgasse wäre — `lookup.js` bietet die
Größenmenge der Kategorie als Auswahl an, sobald nichts passt.

Beim Nachziehen der Test-Fixture fiel ein dritter Fehler auf: die Konfidenz der Auflösung
überschrieb die der Quelle. Eine an den Proportionen **geschätzte** Größe, die zufällig auf
einen Listeneintrag passte, stand als `ok` da und ging ungefragt raus — genau das, was
§7.2 verbietet. Jetzt gilt das kleinere von beidem: ein Treffer in der Liste macht eine
Schätzung nicht sicherer.

**Nachtrag 2026-08-23 — `language_book`: gemessen, weil nicht erfragbar.**

Nach der ISBN lehnte der Create das Buch erneut ab:
`400 language_book: Wähle eine Sprache, um fortzufahren` — derselbe Fehler, der den
Relist-Pfad am 2026-08-12 getroffen hat.

**Vinted nennt die IDs nirgends.** Geprüft:

| Quelle | Antwort |
|---|---|
| `POST /api/v2/item_upload/attributes` für Kategorie 5425 | `attributes: []` — dieselbe leere Antwort bekommt die SPA |
| Upload-Formular für Comics | zeigt Kategorie, ISBN, Zustand, Preis, Versand — **kein Sprachfeld** |
| `item_attributes/…`, `attribute_values?code=…`, `item_upload/languages` | 404 |
| `GET /api/v2/items/{id}` (öffentlich) | führt gar keine Attribute |

Die SPA schickt die Sprache also unsichtbar mit. Bleibt eine Quelle: **ein Buch von Hand
einstellen und nachlesen.** Genau so entstand der Eintrag in `lib/book.js` — Comic 9749905948,
Kategorie 5425, gespeichert als
`item_attributes: [{code:'language_book', ids:[6437]}, {code:'condition', ids:[2]}]`.
Also `de → 6437`.

Zwei Quellen für die Sprache, in dieser Reihenfolge: was das Modell auf dem Umschlag gelesen
hat (es hat das Buch gesehen), sonst die Sprache der Texte aus den Einstellungen — dieselbe
Annahme, die Vinteds Formular trifft, wenn es gar nicht erst fragt.

**Was nicht gemessen ist, wird nicht geraten** (ADR-0005). Für eine Sprache ohne Eintrag hält
`draft.js` den Draft an, bevor das erste Foto hochgeht, und nennt das Kürzel. Der Weg zu
einem weiteren Eintrag ist derselbe wie zu diesem: ein Buch dieser Sprache von Hand
einstellen, `GET /api/v2/item_upload/items/{id}` lesen, ID eintragen. Eine falsche Sprach-ID
fällt niemandem auf, bis ein Käufer ein englisches Buch auspackt.

**Nachtrag 2026-08-23 — ein Buch ohne ISBN nimmt Vinted nicht.**

`400 {"field":"isbn","value":"Bitte gib eine ISBN an, um weiterzugehen"}` — vom Create,
also nachdem alle Fotos oben waren.

**Welche Kategorien sie verlangen, sagt Vinted nirgends.** Der Katalogknoten trägt kein
Kennzeichen (`{id, title, restricted_to_status_id, badge, photo, path, catalogs}` — bei
„Belletristik" identisch zu „Einfarbige T-Shirts"), `offline_verification/criteria`
antwortet für Bücher wie für alles andere `["brand","price"]`, `item_upload/attributes` ist
leer, und die naheliegenden Konfigurations-Endpunkte gibt es nicht (alle 404). Die Regel
gilt deshalb für die ganze Warengruppe `media`. Ein Buch von vor 1970 hat keine ISBN —
meldet das jemand, wird die Regel enger gefasst; bis dahin ist ein Blocker vor dem Upload
billiger als ein Fehlschlag danach.

Drei Quellen, in dieser Reihenfolge: was der Nutzer tippt, was **Vinteds eigene
Fotoerkennung** in `suggestions/attributes` zurückgibt, und was das Modell gelesen hat. Die
mittlere lag schon die ganze Zeit vor und wurde an der Naht fallen gelassen — dieselbe
Sorte Verlust wie einst `high_resolution`. Als Rettung taugt sie allerdings nicht: ein Buch
ohne ISBN blockt in Schritt 1, lange bevor diese Antwort da ist. Der Weg für den Nutzer ist
der umgekehrte, und der bessere: die Nummer steht auf dem Buch in seiner Hand.

Der Prompt sagt dem Modell jetzt, **wo** sie steht (Rückseite über dem Strichcode, im
Impressum; dreizehn Ziffern, meist mit 978) — und dass sie nicht geraten wird: eine
erfundene ISBN benennt ein fremdes Buch.

**Nachtrag 2026-08-23 — der Artikel bleibt in der Mitte, auch wenn er dafür nicht ins Bild passt.**

Zwei Beobachtungen an einem eingestellten Inserat: im Titelbild lief der rechte Ärmel in
die Bildkante, und über dem Pullover stand ein Feld Fußboden.

**Der Ärmel.** `chooseFrame` kann die Box nicht anschneiden — das ist als Invariante
festgeschrieben und getestet. Fehlt der Ärmel trotzdem, war er nicht in der Box; das Modell
hat sie zu eng gezeichnet. Zwei Antworten: der Prompt sagt jetzt, WIE zu messen ist
(„ringsum ein Fingerbreit Hintergrund", mit den Teilen benannt, die zuerst herausfallen —
Ärmelspitzen, Bündchen, Saum, Kapuze), und eine mit dem Auge gezeichnete Box bekommt einen
eigenen Zuschlag (`modelMarginPct`, 6 % **der Box**, nicht des Bildes: der Fehler des
Modells wächst mit dem Gegenstand, nicht mit dem Foto).

**Der Fußboden.** Gemessen an einem 3024×4032-Foto mit flach liegendem Pullover:

| Lage des Artikels | Rand über der Box | darunter |
|---|---|---|
| Bildmitte | 317 px | 318 px |
| unteres Drittel | 1355 px | 41 px |

In der Mitte tadellos, am Rand kippt es. Ursache war die Klemmung an der Bildkante: passte
der zentrierte Rahmen nicht mehr hinein, wurde er verschoben. Das rettet den Bildinhalt und
opfert die Komposition — ein 4:5-Rahmen um einen breit liegenden Artikel ist nun einmal
höher, als das Foto hergibt.

Jetzt wird stattdessen **gefüllt**, in der Farbe des Hintergrunds, den das Foto ohnehin
zeigt. Das kostete keine Zeile in `canvas.js`: `offsetX/offsetY` sagen dort seit jeher, wo
der Originalpixel 0 auf der Leinwand liegt, und für einen Rahmen, der über das Bild
hinausragt, ist das schlicht negativ — die Leinwand schneidet den Überstand selbst ab. Ein
`pad` ist damit kein Sonderfall mehr, sondern der allgemeine Fall, von dem `crop` die
Abkürzung ist. Gemessen fällt in den geprüften Lagen 8–20 % Füllfläche an; wo es zentriert
hineinpasst, wird weiterhin geschnitten.

**Nachtrag 2026-08-23 — eine ausdrückliche Wahl überstimmt die Gegenprobe.**

Derselbe Kinderpullover, einen Schritt weiter: die Navigation führte auf 1672 („Kinder >
Jungs > … > Hoodies & Sweatshirts"), und Vinteds Fotoerkennung antwortete beim
Veröffentlichen mit 1811 („Herren > Kleidung > Pullover & Sweater > Sweater"). Entscheidung
C leert dann das Feld und bietet beide Antworten an.

Das führte im Kreis. Der Nutzer wählt seine Kategorie erneut, veröffentlicht — und Vinted
sagt beim nächsten Mal genau dasselbe wie beim letzten. Für einen Artikel, den die
Fotoerkennung hartnäckig falsch einordnet, gab es keinen Ausgang.

Entscheidung C wägt zwei **maschinelle** Erkennungen gegeneinander, und dort ist der
Widerspruch mehr wert als die Zuversicht einer von beiden. Ein Mensch, der den Artikel in
der Hand hatte und aus der Liste gewählt hat, ist keine dritte Maschine. `crossCheck` lässt
eine Auflösung mit `source: 'pick'` deshalb stehen. Der Widerspruch verschwindet nicht: er
steht als `overriddenBy` am Feld („Vinted sieht auf den Fotos … — deine Wahl steht") und
als `publish_override` im Protokoll. Er blockt nur nicht mehr.

Dazu ein zweiter Fund aus demselben Bildschirm: im Widerspruch trug nur **Vinteds** Antwort
ihren Pfad, die eigene nur ihren Titel — „Hoodies & Sweatshirts" gegen „Herren > Kleidung >
Pullover & Sweater > Sweater". Dass die erste die Kinder-Kategorie ist, war daran nicht zu
erkennen, und der Pfad ist genau das, was die beiden unterscheidet. Die Auflösung führt
ihren Pfad jetzt mit.

**Nachtrag 2026-08-23 — durch den Kategoriebaum navigieren, statt ihn zu erraten.**

Für einen Kinderpullover schlug Vinteds Stichwortsuche nur „Herren > Sweatshirt" vor. Ein
einzelnes Blatt wird übernommen (Konfidenz 0.5, bestätigungspflichtig) — und daran hängt
alles Weitere: die Größenmenge einer Herrenkategorie kennt keine 152.

Der Fehler war die Gleichsetzung von Tippen und Suchen. Ein Wort des Modells ist ein Name,
den man nachschlägt; ein Wort des Nutzers ist der **Anfang eines Weges**. „Kinder" ist keine
Kategorie, und Vinteds Suche kann darauf gar nicht sinnvoll antworten.

`taxonomy.browseCatalogs(label, leaves)` filtert deshalb lokal über den ganzen **Pfad**,
wortweise und als Wortanfang, und gibt eine von zwei Antworten:

- **matches** — die Blätter selbst, wenn es wenige genug für ein Auswahlfeld sind
- **steps** — sonst die nächste Ebene darunter, als Pfad ohne id. Ein Schritt ist kein
  Ziel: das Studio schreibt ihn zurück ins Feld, und dieselbe Filterung greift eine Stufe
  tiefer. Enthält das Getippte ein „>", wird es als Pfad **verankert**, sonst fände
  „Kinder > Mädchen" auch Mädchen-Blätter außerhalb von Kinder.

Ein Schritt, der das Getippte wiederholt, wird durch seine eigene nächste Ebene ersetzt.
Ohne diese Regel bot „Kinder" den Schritt „Kinder" an — das Wort kommt auch in
„Bücher & andere Medien > Bücher > Kinder & junge Erwachsene" und unter „Sport" vor, die
gemeinsame Ebene ist deshalb die Wurzel, und wer den Schritt wählte, bekam dieselbe Liste
zurück. Am echten Baum geprüft (2493 Blätter): „Kinder" → 14 Bereiche, „Kinder > Mädchen"
→ 19 Bereiche, „Kinder > Mädchen > Pullover und Jäckchen" → 8 Blätter. „kinder pullover"
führt in einem Schritt zu denselben drei Pullover-Blättern.

Vinteds Suche bleibt der Ausweg, wenn der Baum das Wort gar nicht kennt („Kapuzenpulli").

**Nachtrag 2026-08-23 — das getippte Größenwort war dekorativ.**

Gemeldet: „„152" ist keine Vinted-Größe — anderen Begriff eintippen, z. B. „T-Shirts"".
Zwei Fehler in einem Satz, und der zweite ist der schlimmere.

**Der Rat kam aus dem falschen Feld.** `NEEDS_ID` hielt nur das Wort für die Sache; der
Nachsatz war für alle drei Felder derselbe — der der Kategorie. Jetzt trägt jeder Eintrag
seinen eigenen Rat.

**Und er führte ins Leere.** Die Größe wurde nur aus `analysis.size_label` aufgelöst; was
der Nutzer tippte, landete in `overrides.size` und wurde nirgends nachgeschlagen — genau
der Zustand, in dem das Kategoriefeld bis 0.81.0 war. Wer dem Rat folgte und „152" tippte,
las denselben Satz noch einmal: eine geschlossene Schleife. Dazu hing die Kandidatenliste
ebenfalls an `analysis.size_label`, sodass ausgerechnet im getippten Fall auch nichts zur
Auswahl stand.

Drei Änderungen: `lookupDraft` nimmt `labels.size` entgegen; die Größenliste steht immer
zur Wahl, sobald eine Größe verlangt wird und keine ID dahintersteht; und das Studio
behandelt ein getipptes Größenwort wie ein getipptes Kategoriewort (nachschlagen, den Fund
als Wahl festnageln, den getippten Text wegwerfen).

Gegen die echte Liste geprüft: „152" trifft in Kategorie 1542 (Kinder > Mädchen >
Pullover) genau einen der 31 Einträge — `631 "12 Jahre / 152"`.

**Nachtrag 2026-08-23 — warum kein Preisvorschlag kommt.**

`/api/v2/item_price_suggestions` antwortet nur auf Kategorie, Marke **und** Zustand
zusammen; fehlt eines, kommt `similar_sold_items_present: false` (gemessen). Und selbst mit
allen dreien gibt es ganze Kategoriefamilien ohne Vergleichsverkäufe — Belletristik,
Sachbücher, Comics, Briefmarken, Notizbücher antworten alle leer, während 24 geprüfte
Marke/Zustand-Kombinationen in Kategorie 1806 ausnahmslos eine Spanne liefern.

Es gibt also vier Lagen ohne Preis, und drei davon sind ordentliche Befunde. Bisher blieb
das Feld dabei leer, und ein leeres Feld sieht aus wie ein Aussetzer. `lookupDraft` gibt
jetzt einen `priceReason` zurück, den `draft-view.js` als Satz unter das Preisfeld schreibt.

**Nachtrag 2026-08-21 — auch die Farbe braucht eine ID, und ein Widerspruch ist nicht bestätigbar.**

Derselbe Fehler wie bei der Kategorie, von der anderen Seite. Widerspricht die Gegenprobe
bei der Farbe, leert `crossCheck` das Feld und bietet beide Antworten an — das Feld zeigt
aber weiter „Blau", stand auf `needs_confirmation`, und **ein Klick auf „Passt" gab das
Veröffentlichen frei**. Heraus kam ein Inserat mit `color_ids: []` und `color1_id: null`.
Damit ließ sich genau der Zwang zur Neuauswahl wegklicken, wegen dem die Farbe überhaupt
ein Blocker ist.

`NEEDS_ID` ist deshalb keine Menge mehr, sondern eine Zuordnung Feld → Wort, und die Farbe
steht darin. Marke und Größe bleiben draußen: beide sind in der Payload nullbar, Vinted
nimmt sogar eine Freitext-Marke.

Zwei Folgeänderungen, ohne die das eine Sackgasse wäre:

- **Ein Blocker braucht einen Ausweg.** Die Kategorie hat Suche und Textfeld; die Farbe hat
  beides nicht — ein getipptes Wort wird für sie gar nicht aufgelöst. `lookup.js` bietet
  deshalb Vinteds ganze Farbliste als Auswahl an, wenn nichts passt. 29 Einträge sind ein
  Auswahlfeld, keine Zumutung.
- **Der Hinweis muss die beiden Lagen unterscheiden.** „„Blau" ist keine Vinted-Farbe" wäre
  bei einem Widerspruch schlicht falsch — Blau *ist* eine Vinted-Farbe, Vinted sieht auf den
  Fotos nur eine andere. Der Konflikt sagt jetzt „Vinted sieht auf den Fotos etwas anderes:
  Blau oder Türkis — bitte unten entscheiden".

Dazu: `publish_suggestions` protokolliert jetzt auch die Farb-IDs. Bisher stand dort nur
`{categories, brands}`, und zu einem `publish_conflict {"blockers":["Farbe bestätigen"]}`
ließ sich nirgends nachlesen, was Vinted stattdessen gesehen hatte.

**Nachtrag 2026-08-21 — der 401 ist die abgelaufene Sitzung, nicht die fehlende Kategorie.**

Symptom: eine Kategorie im Studio auswählen tut nichts Sichtbares, und es kommt kein
Preisvorschlag mehr. Im Log dreimal `studio_lookup_failed {"status":401,
"message_code":"invalid_authentication_token"}`.

Der Befund: Vinteds Sitzungs-Cookie ist kurzlebig und wird von der SPA nachgezogen, solange
irgendwo ein Vinted-Tab offen ist. Ohne offenen Tab altert es weg — und dann antwortet jeder
Lesezugriff aus dem Studio mit 401, obwohl der Nutzer angemeldet ist und vinted.de im
Browser normal funktioniert. Gemessen am selben Tag: 08:12 mit offenem Tab alle Lesezugriffe
200, 12:01 ohne Tab dreimal 401, nach dem Öffnen von vinted.de sofort wieder 200 (geprüft
für `brands`, `conditions`, `catalogs/search`). Ein veralteter oder erfundener
`X-CSRF-Token` löst den 401 **nicht** aus — die GETs beantworten ihn auch mit Unsinn im
Header mit 200.

Das ist die Kehrseite der Spike-Erkenntnis „Lesen geht ohne offenen Vinted-Tab": es geht
ohne Tab, aber nicht ohne frische Sitzung. Drei Änderungen:

1. **`vinted-read.js`** wirft bei 401 einen `AuthError` mit `SESSION_EXPIRED` — einem Satz,
   der die Abhilfe nennt, statt `HTTP 401: {"code":100,…}`, das den Nutzer an der falschen
   Stelle suchen lässt.
2. **`lookup.js#searchCatalog`** verschluckte bisher *jeden* Fehler und gab `null` zurück.
   Ein 401 kam damit als „„T-Shirt" ist keine Vinted-Kategorie" heraus — eine Auskunft über
   Vinteds Baum, ohne dass Vinted geantwortet hätte. Dieselbe Sorte stiller Fehlschlag wie
   die 200-mit-leerer-Liste bei den Größen. Ein `AuthError` fliegt jetzt durch.
3. **`studio.js`** gibt `runLookup()` die Fehlermeldung zurück, und jeder Aufrufer schreibt
   sie in die Statuszeile. Vorher landete sie nur in der Hinweisliste am Seitenende — bei
   einem Klick auf eine Kategorie sah das aus, als sei nichts passiert.

**Nachtrag 2026-08-21 — die Sendungsgröße liegt woanders, und die Pflichtfelder sind keine.**

Zwei Löcher in der Payload, beide gemessen statt vermutet — im laufenden `/items/new`, mit
dem Netzwerkmitschnitt daneben.

**`package_size_id: null`.** Das Formular verlangt die Sendungsgröße („Bitte wähle eine
Sendungsgröße aus") und markiert eine als „Empfohlen"; wählt man eine Kategorie, ruft die
SPA dafür `POST /shipping-estimation/external/package_sizes/suggestion` auf. Der gebaute
`taxonomy.packageSize` hätte diesen Aufruf nie hinbekommen, aus drei Gründen:

1. **Anderer Host.** `www.vinted.de/shipping-estimation/…` ist die 404-HTML-Seite,
   `api.vinted.de/shipping-estimation/…` antwortet `{"package_size_id":1}`.
2. **Keine Auth-Header.** Mit `X-CSRF-Token`/`X-Requested-With` scheitert schon der
   CORS-Preflight („Failed to fetch"); ohne sie kommt 200. Die Anmeldung sind die Cookies —
   ohne `credentials: 'include'` ist die Antwort 403.
3. **Falsche Schicht.** `upload_session_id` ist Pflicht (sonst 422), existiert also erst
   nach dem Foto-Upload. Der Aufruf gehört in `draft.js`, nicht in die Vorbereitung.

Gemessene Antworten: T-Shirt → 1 (`SMALL`), Buch → 2 (`MEDIUM`), Schuhe → 2. Eine
unbekannte Kategorie wird mit `{"package_size_id": null}` und Status 200 beantwortet — null
ist eine Antwort, kein Fehler, und wird als `null` weitergereicht.

**`item_attributes: []`.** `taxonomy.requiredFields` sah nach der Pflichtfeldliste der
Kategorie aus. Sie ist keine: `/api/v2/offline_verification/criteria/{id}` antwortet für
elf geprüfte Kategorien — T-Shirts, Jacken, Schuhe, Sachbücher, Belletristik, Kinderbücher,
Spielzeug — immer `["brand","price"]`, während das Upload-Formular für Belletristik
überhaupt kein Markenfeld zeigt (dort stehen Kategorie, ISBN, Zustand, Preis, Versand). Als
Sperre hätte sie genau die Drafts angehalten, die in Ordnung sind. Sie ist deshalb entfernt.

Was eine Kategorie wirklich führt, beantwortet `POST /api/v2/item_upload/attributes`, und
zwar nur mit dem Körper `{catalog_id, attributes: []}` — `{catalog_id}` allein und die
Varianten mit `attributes: [{code: 'category', …}]` sind 422. Für jede geprüfte Kategorie
ist die Liste leer; `item_attributes: []` ist also für den heutigen Bestand richtig. Der
Aufruf steht trotzdem in der Pipeline, **vor** dem ersten Upload: meldet Vinted dort etwas,
das keine eigene Spalte in der Payload hat, hält der Draft an und nennt die Codes. Geraten
wird nichts (ADR-0005) — im Relist-Pfad wird der Beutel aus dem Vorgänger-Artikel
zurückgespielt, hier gibt es keinen.

**Nachtrag 2026-08-21 — `value` ist das Wort, `id` ist die ID (auch beim Zustand).**

Die Zusammenfassung eines sauberen Trockenlaufs las sich
`Marke=Superdry, Kategorie=Einfarbige T-Shirts, Größe=M, Farbe=Türkis, Zustand=2`. Der
Zustand war das einzige Feld, dessen `value` eine ID war statt eines Wortes — und damit das
einzige, das man am Artikel in der Hand nicht nachprüfen kann. Für ein Feld, das aus genau
diesem Grund immer bestätigt werden muss (§7.5), ist das die falsche Anzeige.

`draftView` gibt für den Zustand jetzt Vinteds eigenen Titel als `value` und die
`status_id` als `id` — dieselbe Form wie bei Marke, Kategorie, Größe und Farbe. Der Titel
kommt aus der geholten Liste (`conditionTitleFor`), nicht aus unserem Vokabular: im
Auswahlfeld steht Vinteds Wort, auf dem Bildschirm soll dasselbe stehen. Ist die Liste noch
nicht da, bleibt die nackte ID stehen — ein Zustand, der als leer gilt, würde sonst blocken.

Zwei Stellen lasen bisher `field.value` als ID und lesen jetzt `field.id`: die Payload
(`draft.js` → `statusId`) und das Auswahlfeld im Studio.

**Nachtrag 2026-08-20 — die Kategorie braucht eine ID, kein Wort.**

Ein Trockenlauf scheiterte mit `Pflichtfeld fehlt: catalog_id` — und zwar erst beim Bauen
der Payload, also nachdem das Schreib-Schloss genommen und drei Fotos hochgeladen waren.
Ursache: das Kategoriefeld fällt auf das rohe Wort des Modells zurück („Hoodie"), sah
damit gefüllt aus, stand auf `needs_confirmation`, und ein Klick auf „Passt" gab das
Veröffentlichen frei. Bestätigen kann aber keine ID herbeischaffen.

Drei Änderungen, in dieser Reihenfolge:

1. **`draft-view.js`** kennt `NEEDS_ID` — bisher nur die Kategorie, weil nur sie in
   `buildNewItemPayload` zum Wurf führt (Marke und Größe sind in der Payload nullbar). Ein
   Feld darin ohne aufgelöste ID ist `missing`, und zwar **vor** der Bestätigungsprüfung.
   Damit blockt der Draft im Studio, statt nach dem Upload zu scheitern.
2. **`lookup.js`** ruft `taxonomy.searchCatalogs` als Rückfallebene, wenn die exakte
   Titelgleichheit nichts findet. Ein Treffer wird übernommen, aber mit Konfidenz 0.5 —
   gefunden, nicht geprüft. Mehrere Treffer sind eine Auswahl, keine Rangliste.
3. Das getippte Kategoriefeld wirkt: `lookupDraft({ labels: { category } })`. Vorher war
   es dekorativ — Text ändern, sonst nichts, und ein unauflösbarer Draft hatte gar keinen
   Ausweg.

**Nachtrag 2026-08-20 — die Erkennung bekommt das ungeschnittene Foto.**

Bis 0.78.0 lief die Reihenfolge zuschneiden → erkennen. Der Zuschnitt ist eine Heuristik,
die einfarbigen Hintergrund abschält und alles andere behält; einen Begriff davon, was der
Artikel *ist*, hat sie nicht. An einem echten Foto behielt sie 26 % der Fläche, und das
Größenetikett lag in den weggeworfenen 74 %. Die Erkennung meldete daraufhin korrekt
`size_label: null` — sie hatte nichts mehr zu lesen.

Seit 0.79.0 gilt: **das Modell sieht das Foto, wie es aufgenommen wurde.** Der Zuschnitt
folgt aus seiner Antwort, nicht umgekehrt.

1. Aufnahme → `prepare()` erzeugt zwei Ausgaben aus **einem** Bitmap: die Inseratsdatei
   (heuristischer 4:5-Zuschnitt, 1080×1350, sofort als Vorschau) und die Modellkopie
   (**ganzes Bild**, bis 1568 Kantenlänge, q0.92).
2. Ein Erkennungs-Call über alle Modellkopien. Das Modell liefert je Foto `article_box`
   (normiert 0–1) und `distractions`.
3. Zweiter Durchgang: betroffene Fotos werden **aus der Originaldatei** neu gezeichnet,
   gerahmt nach `article_box`. Zwei Zuschnitte hintereinander würden genau die Pixel
   kosten, um die es geht.

`crop.modelBoxVerdict` entscheidet, ob eine Box benutzbar ist, und sagt warum nicht:
`malformed`, `outside`, `not_a_box`, `too_small`, `in_padding` — oder `full_frame`, was
**kein** Einwand ist, sondern „der Artikel füllt das Bild ohnehin". Die Garantie aus §5.2
bleibt unberührt: die Box läuft durch dasselbe `chooseFrame` wie vorher, und ein
Crop-Rahmen, der ins Objekt schneiden würde, wird weiterhin zu einem Pad.

**Was in der Praxis entscheidet, ist `too_small` — und es fragt nach Pixeln, nicht nach
Fläche.** `targetSize` rechnet nie hoch, ein schmaler Rahmen ergibt also ein schmales
Inseratsbild. Der Rahmen muss deshalb mindestens `maxW / maxUpscale` = **432 px** breit
werden. Gemessen an einem 3024×4032-Foto entspricht das je nach Form der Box sehr
verschiedenen Flächenanteilen — quadratisch 1,44 %, ein breites Etikett (4:1) schon
0,50 %. Die Flächengrenze `minModelBoxPct` (0,5 %) greift dadurch fast nie; sie hat mit
`not_a_box` einen eigenen Grund, damit im Log ablesbar bleibt, welche Schwelle gegriffen
hat. Ob 432 px die richtige Untergrenze sind, ist **nicht gemessen** — `maxUpscale` ist die
Stellschraube.

**Nachtrag 2026-08-23 — die Box gehört auf jedes Foto, nicht nur auf gestörte (v0.109.0).**

Bis 0.108 verlangte der Prompt die `article_box` nur, wenn etwas Störendes im Bild lag;
sonst sollte sie `null` sein. Der zweite Durchgang lief damit nur für Störungsfotos, und
bei jedem sauberen Foto — ein Artikel frei auf dem Boden — entschied allein die
Hintergrund-Heuristik über den Zuschnitt. Auf strukturiertem Boden (Holzmaserung, dazu ein
grauer Artikel in ähnlicher Helligkeit) schält die Heuristik oben/unten/links/rechts
ungleich viel weg: die Objektbox wird asymmetrisch, der 4:5-Rahmen sitzt nicht mittig auf
dem Artikel. Gemeldet als „Bilder nicht mittig, nicht gut zugeschnitten" (Version 0.108).

Seither gilt: **das Modell umreißt den Artikel auf JEDEM Foto**, und der Rahmen wird mittig
auf diese Box gesetzt. `article_box` ist nur noch dann `null`, wenn der Artikel das Bild
schon randlos an allen vier Seiten ausfüllt. Die Hintergrund-Heuristik bleibt reiner
Rückfall — für Fotos, die nicht in `photo_order` stehen, oder wenn `modelBoxVerdict` die
Box verwirft. Kein zusätzlicher KI-Aufruf: dieselbe `analyse`-Antwort, nur immer mit Box;
der zweite Zeichen-Durchgang lief für Störungsfotos ohnehin schon.

**Nachtrag 2026-08-20 — Größen und Zustände, korrigiert.**

Der erste Durchgang hatte beide Listen aus der `attributes`-Antwort gelesen. Für die Größen
war das eine ungeprüfte Annahme, für die Zustände eine aus dem Verhalten der Oberfläche
abgeleitete Vermutung. Beides ist falsch, und beides fiel deshalb gleichzeitig aus: kein
Zustand war auswählbar, keine Größe wurde je aufgelöst. Nachgemessen:

* **Größen** kommen aus `GET /api/v2/item_upload/size_groups`, und der Parameter heißt
  **`catalog_ids[]`** — Plural, mit Klammern. Mit dem naheliegenden `catalog_id` antwortet
  Vinted `200 {"size_groups": []}`: ein Erfolg mit leerer Liste. Genau deshalb ist nichts
  aufgefallen — es gab keinen Fehler, nur nie eine Größe. Eine Kategorie kann mehrere
  Gruppen zurückgeben (ein Schuh hat EU und UK); die Titel sind je nach Gruppe „M" oder
  „M / 38 / 10", was das `splitOn: '/'` in `resolve.js` abfängt.
* **Zustände** kommen aus `GET /api/v2/item_upload/conditions?catalog_id={id}`, mit
  `explanation` — Vinteds eigener Definition der Stufe. Fünf Kategorien quer durch den
  Baum (Herren-Shirt, Damen-Shirt, Schuhe, 1187, 2312) gaben dieselben fünf zurück:

  | id | Titel | |
  |---:|---|---|
  | 6 | Neu, mit Etikett | mit Etikett oder original verpackt |
  | 1 | Neu | ohne Etikett oder Originalverpackung |
  | 2 | Sehr gut | nur selten benutzt |
  | 3 | Gut | benutzt, mögliche Gebrauchsspuren |
  | 4 | Zufriedenstellend | oft benutzt, Mängel |

  **„Sehr gut" ist die 2, nicht die 3.** `/api/v2/statuses` liefert zusätzlich
  `7 = Nicht voll funktionsfähig`, das beim Einstellen **nicht** angeboten wird — der
  Grund, warum trotz gemessener Zahlen keine Tabelle im Code steht (ADR-0005) und warum
  `lookup.js` einen Zustand verwirft, den die aktuelle Liste nicht enthält.

**Preisvorschlag — der wichtigste Befund.**

```
GET /api/v2/item_price_suggestions?catalog_id=196&brand_id=53&status_id=2
{
  "price_suggestion": {
    "minimum":  { "amount": "4.0", "currency_code": "EUR" },
    "maximum":  { "amount": "9.0", "currency_code": "EUR" },
    "midpoint": { "amount": "6.0", "currency_code": "EUR" },
    "price":    { "amount": "8.0", "currency_code": "EUR" },
    "currency": "EUR"
  },
  "similar_sold_items_present": true,
  "code": 0
}
```

- **Kein Foto nötig.** Drei Query-Parameter, sonst nichts. Der Vorschlag steht also schon
  in der Vorbereitung zur Verfügung, nicht erst nach dem Upload — anders als die
  Sendungsgröße, die ohne `upload_session_id` gar nicht existiert.
- **Alle drei Parameter sind nötig.** Ohne `brand_id` antwortet der Endpoint mit `200`,
  aber ohne `price_suggestion` und mit `similar_sold_items_present: false`.
- **`similar_sold_items_present` ist die Ehrlichkeitsangabe**: false heißt, es gibt keine
  Vergleichsverkäufe. Das ist genau die Bedingung aus §7.4 — keine Spanne, kein
  automatischer Preis.
- **Vinted rechnet den Mittelwert selbst**, und zwar nicht arithmetisch: bei 4–9 € nennt
  es `midpoint: 6.0`, nicht 6.5. Daneben steht ein höheres `price` (8.0). `price.js` sollte
  Vinteds `midpoint` übernehmen statt selbst zu mitteln — es stammt aus deren Verkaufsdaten.
- **Der Zustand bewegt die Spanne stark**: derselbe Artikel mit `status_id: 6` statt `2`
  ergibt 11–23 € statt 4–9 €. Entscheidung W3 (bei Zustandswechsel neu holen) ist damit
  keine Vorsichtsmaßnahme, sondern notwendig.

**Vinteds eigene Fotoerkennung — Prüfpunkt 1, gemessen mit zwei echten Fotos.**

Der Upload-Flow erkennt den Artikel selbst, und zwar allein aus den Bildern — ohne Titel,
ohne Beschreibung. Die Kette ist dreistufig:

```
1. POST /api/v2/photos                      (multipart, wie beim Relist)
   → { id, high_resolution: { id: "03_00f15_MDsRx…" }, dominant_color, … }
                                 └── DAS ist die image_id für Schritt 2 und 3,
                                     nicht die numerische `id`

2. POST /api/v2/item_upload/suggestions/categories
   { image_metadata: [{ image_id, orientation }], upload_session_id }
   → { categories: [1807, 1806], prefill_categories: [1807], legacy_first_category: 1807 }

3. POST /api/v2/item_upload/suggestions/attributes
   { title, description, category_id, image_metadata, upload_session_id, attributes }
   → { brands: […], colors: […], sizes: […], isbn, dynamic_attributes }
```

Gemessenes Ergebnis für ein blaues T-Shirt, zwei Fotos:

| Feld | Was Vinted zurückgab |
|---|---|
| Kategorie | `1807` Bedruckte T-Shirts, `1806` Einfarbige T-Shirts (Herren › Kleidung › Tops & T-Shirts) |
| Marke | `787` Ellesse |
| Farben | `27` Marineblau, `15` Bunt |
| **Größe** | **leer** |
| ISBN | null |

**Vinted löst `catalog_id`, `brand_id` und die Farb-IDs selbst auf** — fertige IDs, kein
String→ID-Mapping nötig. Was es **nicht** liefert, ist die Größe: die steht auf dem
Etikett und braucht Texterkennung.

Damit verschiebt sich die Arbeitsteilung gegenüber dem Konzept (§6.6 hatte genau das als
offene Frage markiert):

- **Vinted** erkennt Kategorie, Marke, Farbe — mit ihren eigenen IDs.
- **Unser Modell** liefert, was Vinted nicht kann: Größe vom Etikett, Titel-Slots,
  Beschreibung, Fotoreihenfolge, Zuschnitt-Prüfung.
- `resolve.js` schrumpft entsprechend: die Kandidatenliste zu einer erkannten Kategorie
  kommt aus dem Baum, aufzulösen ist nur noch die Größe.

Ein Vorbehalt: die Erkennung läuft erst **nach** dem Foto-Upload, ist also schreibend im
Sinne von §4.5 und nicht Teil der freien Vorbereitung. Für den Preisvorschlag gilt das
nicht — der braucht nur die drei IDs.

**Marken mit Echtheitsprüfung.** Trägt eine Marke `requires_authenticity_check`, zeigt die
SPA vor dem Einstellen einen Dialog (`GET /api/v2/items/authenticity_modals`) und verlangt
Fotos von Logo, Pflegeetikett und aufgenähten Labels. Für das Auto-Listing heißt das: eine
solche Marke ist kein Grund abzubrechen, aber der Nutzer muss es wissen — sonst wird das
Inserat später versteckt.

### Lesende Calls aus einer Extension-Page (Spike 0b, Prüfpunkt 3 — 2026-08-14)

**Befund: Lesen geht direkt.** Ein `GET` aus der Studio-Page (`chrome-extension://`-Origin)
auf `/api/v2/item_upload/items/{id}` liefert **200 mit JSON**, sobald die üblichen Header
mitgehen. Ohne sie kommt **403 mit einer HTML-Seite** — also nicht die JSON-Ablehnung der
API, sondern die Abwehrschicht davor.

Gemessen mit demselben Artikel, nur die Header unterschieden sich:

| Aufruf aus der Studio-Page | Ergebnis |
|---|---|
| ohne Header | `403` · HTML |
| mit `X-CSRF-Token`, `X-Anon-Id`, `X-Requested-With`, `X-Enable-Multiple-Size-Groups`, `X-Upload-Form` | `200` · JSON |

Konsequenzen:

- **Der Origin ist für lesende Calls kein Hindernis.** Die 403 kam von den fehlenden
  Headern, nicht von `chrome-extension://`.
- **Einen Draft vorzubereiten braucht keinen offenen Vinted-Tab.** Taxonomie, Markensuche
  und Preisspanne holt das Studio selbst; `taxonomy.js` bekommt `fetch` als Transport
  injiziert (Entscheidung 15 im Auto-Listing-Konzept). Eine eigene Nachricht an den Worker
  gibt es dafür nicht — das im Konzept geplante `draft/lookup` wurde nie gebraucht. Nur das
  **Veröffentlichen** überquert die Naht.
- **Der Auth-Bundle muss trotzdem vorliegen.** Die Tokens stammen aus dem
  webRequest-Snooping des Service Workers und werden pro Domain persistiert — ein einmal
  besuchter Vinted-Tab genügt, ein *offener* nicht.
- **Für schreibende Calls ändert das nichts.** ADR-0001 bleibt unangetastet: der Create
  wurde in diesem Versuch **nicht** getestet, und die CSRF-/Origin-Prüfung beim Schreiben
  ist genau der Punkt, an dem der SW-`fetch` seinerzeit scheiterte. Fotos hochladen und
  Artikel erstellen laufen weiter über den Content-Script.

---

## 7. Die Pipelines im Detail

### 7.1 Relist

Siehe [Ablaufdiagramm §2](./ABLAUFDIAGRAMM.md#2-relist-pipeline-hauptablauf). Phasen &
Fortschritt — die Spalte „Marke" ist der Wert aus `RELIST_STEPS`, ab dem die Oberfläche
diese Phase als laufend zeigt:

| Marke | % | Phase | Funktion |
|---|---|---|---|
| 0 | 2 | Anmeldung prüfen | `ensureAuth` |
| 10 | 10 | Artikeldaten laden | `fetchItemViaPage` |
| 20 | 20–75 | Fotos: download → reencode → upload | `fetchAsBlob`, `reencode`, `uploadPhotoViaPage` |
| 75 | 80 | Neuen Artikel erstellen | `createItemViaPage` |
| 88 | 88 | Neuen Artikel prüfen (Backoff 1.5/2.5/4/5.5 s) | `verifyCreated` |
| 92 | 92 | Original löschen | `deleteItemViaPage` |
| — | 100 | Verlauf schreiben | `addEntry` |

**Rückgabeformen** von `relist()`:
- `{oldId, newId, newUrl}` — Erfolg (Original gelöscht).
- `{testMode, oldId, newId, newUrl, oldUrl}` — Test-Modus (Original behalten).
- `{partial, oldId, newId, newUrl, warning}` — Klon erstellt, Original **nicht** gelöscht
  (Verifikation/Owner/Löschen fehlgeschlagen).
- *throw* — harter Fehler vor Erstellung (Original unberührt).

### 7.2 Auto-Listing (Publish-Hälfte)

Die Vorbereitung — Zuschnitt, Erkennung, Auflösung — läuft komplett im Studio und erreicht
den Worker nie; das hält ihn von der 30-Sekunden-Grenze frei. Über die Naht geht nur die
schreibende Hälfte: ein Call, eine Antwort (`draft/publish` → `publishDraft`).

| Marke | % | Phase | Funktion |
|---|---|---|---|
| 0 | — | Kategorie prüfen (Feldzustand, Schreib-Schloss) | `draftView`, `withWriteLock` |
| 15 | 15–70 | Fotos hochladen (eine `uploadSessionId`, 400 ms Pause) | `uploadPhotoViaPage` |
| 70 | 70 | Gegenprobe bei Vinted (Entscheidung C) | `crossCheck` |
| 80 | 80 | Inserat bauen (+ Paketgröße erfragen) | `buildNewItemPayload`, `suggestPackageSizeViaPage` |
| 90 | 90 | Inserat einstellen | `createItemViaPage` |
| — | 100 | Fertig — oder „Testlauf, nichts gesendet" | `addEntry` |

`tests/steps.test.js` pinnt `DRAFT_STEPS` an genau diese Marken: laufen Pipeline und
Phasenliste auseinander, fällt es im Test auf und nicht erst im Toast.

**Rückgabeformen** von `publishDraft()`:
- `{itemId, url}` — Erfolg.
- `{dryRun, payload}` — `draftCreateEnabled: false`, nichts gesendet.
- `{conflict, resolved, blockers, title}` — Vinteds eigene Erkennung widerspricht. **Kein
  throw**: die Entscheidung gehört dem Nutzer, und dafür braucht die Oberfläche beide
  Antworten.

---

## 8. Speicher (chrome.storage.local)

| Key | Form | Modul |
|---|---|---|
| `liveTokens` | `{ [domain]: {csrf, anonId, ts} }` | auth.js (Snooper) |
| `sessions` | `{ [domain]: {csrf, anonId, vUdt, vUid, ts} }` | auth.js |
| `settings` | siehe §9 | settings.js |
| `relistHistory` | `[{ts, oldId, newId, title, domain, testMode}]` (≤100) | history.js |
| `progress` | `{pct, step, steps, ts}` — `steps` ist die Phasenliste, siehe §4 | progress.js, steps.js |
| `log` | `string[]` (≤500) | logger.js |
| `confirmedDelete` | `boolean` — erstes Löschen bestätigt | confirmation.js |
| `confirmedCreate` | `boolean` — erstes echtes Anlegen bestätigt | confirmation.js |
| `taxonomy` | Kategorie-/Größen-Cache mit TTL | taxonomy.js |
| `priceMemory` | gemerkte Preise je Kategorie | price-memory.js |
| `anthropicKey` | verschlüsselter API-Key (nie im Klartext) | secret.js |

Dazu **`chrome.storage.session`**: `anthropicKeyPlain` — der entsperrte Key, nur für die
Dauer der Browser-Sitzung, nie auf der Platte.

---

## 9. Einstellungen

**Relist**

| Key | Default | Wirkung |
|---|---|---|
| `deleteEnabled` | `true` | `false` = Test-Modus, Original bleibt |
| `photoQuality` | `0.92` | JPEG-Qualität beim Re-Encoding (0.6–0.98) |
| `cooldownWarnPerHour` | `5` | Soft-Warnung ab N Relists/Stunde |
| `cooldownWarnPer24h` | `30` | Soft-Warnung ab N Relists/24 h |
| `interestWarn` | `true` | Warnung bei Favoriten/Aufrufen/Gesprächen |
| `verifyAfterCreate` | `true` | Klon vor dem Löschen re-fetchen |
| `defaultColorId` | `15` | Rückfallfarbe („Bunt"), wenn die Kategorie eine Farbe verlangt und das Original keine hat |

**Auto-Listing (ADR-0007)**

| Key | Default | Wirkung |
|---|---|---|
| `draftCreateEnabled` | `false` | **Trockenlauf** ist der Default: Payload bauen, loggen, nichts senden |
| `draftLanguage` | `'de'` | Sprache der Texte — feste Wahl, nicht aus der Domain abgeleitet |
| `draftConditionDefault` | `'very_good'` | Vorauswahl des Zustands — eine Cursorposition, keine Aussage: gilt bis zur Bestätigung als offen |
| `draftMinPrice` | `0` (aus) | Untergrenze gegen eine falsche Kategorie mit falschem Preisband |
| `draftConfidenceThreshold` | `0.8` | Darunter blockiert ein Feld, bis es bestätigt wird |
| `draftDescriptionTemplate` | s. `settings.js` | Die Beschreibung wird **gefüllt**, nicht erfunden — ohne Maße, ohne Zustandsprosa |
| `cropCheckMode` | `'all'` | Jedes zugeschnittene Foto vom Modell gegenprüfen (`'uncertain'` = nur die unsicheren) |

---

## 10. Sicherheitsnetze

- **create-then-delete** + **Post-Create-Verifikation** (Backoff) → kein Datenverlust bei
  Backend-Verzögerung.
- **Ownership-Check** vor dem Löschen (`vUid == seller_id`).
- **Erst-Bestätigung** beim ersten destruktiven Lauf (einmalig, gespeichert).
- **Cooldown-Warnungen** (1 h / 24 h) gegen Anti-Bot-Auffälligkeit.
- **Interest-Warnung** vor Verlust von Likes/Views/Gesprächen.
- **Datadome/Cloudflare-Erkennung**: Block-Antworten werden als verständliche Meldung
  ("aus- und wieder einloggen") statt als HTML-Müll gezeigt.
- **`logger.log` wirft nie.** Es steht an über dreißig Stellen, mehrere davon in
  `catch`-Blöcken, deren einzige Aufgabe es ist, Vinteds feldweise Auskunft zu retten. Ein
  `await` auf eine abgelehnte Log-Zeile würde dort **aus dem catch heraus** werfen, und beim
  Nutzer käme ein Speicherfehler an statt „isbn: Bitte gib eine ISBN an". Der Preis ist
  ausgesprochen: ein kaputtes Log schweigt (die Konsole bekommt die Zeile trotzdem).
- **Foto-Re-Encoding** mit Qualitäts-Jitter gegen Duplikat-Hashing.

Für das Auto-Listing kommen dazu:

- **Trockenlauf als Default** (`draftCreateEnabled: false`) — scharf geschaltet wird von
  Hand, und beide Oberflächen sagen jederzeit, welcher Modus gilt.
- **Feldzustand statt Optimismus** (`draft-view.js`): jedes Feld ist `ok`,
  `needs_confirmation` oder `missing`; veröffentlicht werden kann erst, wenn nichts mehr in
  den letzten beiden steht. Was das Modell unsicher erkannt hat, blockiert. **Jede Sperre
  hängt an einem Feld** — eine Blocker-Zeile ohne Feld, das man ändern kann, ist keine
  Prüfung, sondern eine Wand (so geschehen mit der Buchsprache).
- **Was mitgeschickt wird, gilt als beantwortet — mehr nicht** (`unfillableAttributeCodes`):
  die Vorab-Prüfung der Kategorie-Attribute bekommt den Beutel übergeben, den dieser Lauf
  tatsächlich sendet. Eine feste Ausnahmeliste hatte `language_book` pauschal als erledigt
  geführt, obwohl ihn nur Bücher füllen.
- **Die Form wird geputzt, der Inhalt nicht erraten** (`book.js#normaliseIsbn`): eine ISBN
  steht auf jedem Buchrücken mit Bindestrichen und wird auch so abgetippt — das ist dieselbe
  Nummer, also gehört sie normalisiert, nicht abgelehnt. Was danach keine ISBN ist, blockt
  am Feld statt bei `createItem` nach dem Upload.
- **Ein unaufgelöstes Wort verwirft die vorige Auflösung** (`draft-view.js`): ein getipptes
  Wort, das das Nachschlagen nie hervorgebracht hat (401, Netz weg), macht das Feld ID-los,
  statt auf den alten Wert zurückzuspringen. Sonst wird das Wort des Nutzers verworfen und
  ihm gleichzeitig als Bestätigung angerechnet. Gilt für **jedes** Feld mit Neuabfrage
  (`RELOOKUP_ON_TYPE` — Kategorie und Größe): bei der Kategorie gewinnt das getippte Wort
  sogar die Anzeige, während die ID die der vorigen Kategorie bliebe.
- **Gegenprobe bei Vinted** (Entscheidung C): vor dem Anlegen wird Vinteds eigene
  Foto-Erkennung befragt; Widerspruch blockt — **außer** das Feld ist eine ausdrückliche
  Wahl des Nutzers (`overriddenBy`), sonst wäre die eigene Antwort nicht durchsetzbar.
- **Schreib-Schloss** (`write-lock.js`): nur ein schreibender Lauf gleichzeitig.
- **Erst-Bestätigung** auch vor dem ersten echten Anlegen (`confirmedCreate`).
- **Der Key verlässt den Tab nicht:** verschlüsselt in `storage.local`, entsperrt nur in
  `storage.session`, benutzt nur im Studio.

---

## 11. Build, Validierung & Tests

Kein Build-Step — die Extension wird als „entpackte Erweiterung" geladen. Die ganze
Toolchain sind vier Skripte ohne eine einzige Abhängigkeit:

```bash
npm run validate   # manifest.json, JS-Syntax, ESM-Import-Graph (mit chrome/DOM-Stub)
npm test           # node:test Suite — 868 Tests, ~3 s
npm run coverage   # Coverage-Report
npm run check      # validate + test
```

**`npm run coverage`, nicht `npx c8`.** Der Skript-Weg nutzt die eingebaute Abdeckung von
`node:test` und schreibt nichts auf die Platte. `c8` legt pro Lauf V8-Rohdaten in
`coverage/tmp/` ab und räumt sie nie weg — nach ein paar Läufen sind das 16 MB. Der Ordner
ist zwar in `.gitignore`, aber die Erweiterung wird **entpackt** geladen: Chrome zeigt in
`chrome://extensions` die Größe des ganzen Ordners an, und aus 2 MB werden so 18 MB.
Aufräumen: `rm -rf coverage`.

**Coverage-Strategie:** Reine + Storage-Module via In-Memory-chrome-Mock
(`tests/helpers/chrome-mock.js`) auf ~98–100 %. Beide Pipelines laufen im Test gegen einen
Fake-Port, sodass `relist.js` und `draft.js` ohne Browser prüfbar sind; `missingMembers()`
hält Fake und Live-Adapter dabei auf derselben Schnittstelle **samt Stelligkeit**.

Bewusst **nicht** unit-getestet: `popup/`, `studio/` und `content/` — dort wird nichts
entschieden, was sich testen ließe (siehe §2). Ebenfalls nur end-to-end im Browser
validiert: `image-utils.reencode` und `studio/canvas.js` (beide brauchen ein echtes
Canvas).

**Laden:** `chrome://extensions` → Entwicklermodus → „Entpackte Erweiterung laden" →
Projektordner. Bei Permission-Banner (cookies/webRequest) bestätigen. Nach Code-Änderung
⟳ klicken **und** den Vinted-Tab neu laden (Content-Script wird nur in frische Tabs
injiziert; der SW injiziert sonst automatisch nach).

---

## 12. Bekannte Grenzen & Wartung

- **Undokumentierte API:** Endpoint-/Feldnamen können sich ändern. Bricht `createItem`
  mit 422, einen manuell erstellten Artikel per DevTools-Network vergleichen und
  `buildItemUploadPayload` in `lib/item.js` anpassen.
- **DOM-Selektoren:** Der Relist-Button hängt an `[data-testid^="product-item-id-"]` und
  `button[data-testid="bump-button"]`. Ändert Vinted diese, bricht nur die Injektion
  (Popup-Weg bleibt). Selektoren in `content/content.js` anpassen.
- **Anti-Bot:** Massenhaftes Relisten kann zu Datadome-Challenges/Sperren führen. Es gibt
  bewusst keinen Bulk-Modus; Cooldown-Warnungen sind nur weich.
- **Mobile-API** wird nicht unterstützt (leicht abweichend).
- **Versionierung:** Bei jeder Code-Änderung wird die Minor-Version in `manifest.json` +
  `package.json` erhöht, damit nach dem Reload sichtbar ist, dass die neue Version läuft.
  Beide Oberflächen zeigen sie an — nach einem „bitte neu laden" ist das die einzige
  Auskunft darüber, ob es geschehen ist.
- **Buchsprachen** (`lib/book.js`): Vinted gibt die `language_book`-IDs nirgends preis —
  kein Katalogfeld, kein Attribut-Endpoint, im Formular für Comics nicht einmal ein
  Sprachfeld. Jede ID in `BOOK_LANGUAGES` stammt aus einem von Hand eingestellten Inserat.
  Was dort nicht steht, wird nicht geraten: das Sprachfeld blockt, bevor ein Foto hochgeht,
  und bietet die belegten Sprachen zur Auswahl an. Eine neue eintragen = ein Inserat in
  dieser Sprache von Hand anlegen, `GET /api/v2/item_upload/items/{id}` lesen, die ID in
  `BOOK_LANGUAGES` ergänzen — Auswahlfeld und ID-Tabelle wachsen dann gemeinsam mit.
- **Preisvorschlag:** Für ganze Kategoriefamilien liefert Vinted keine Vergleichsartikel;
  dann gibt es keinen Vorschlag, und der Preis bleibt eine Eingabe. Alle drei IDs
  (Kategorie, Größe, Zustand) müssen stehen, bevor überhaupt gefragt werden kann.
- **Phasenliste und Pipeline** müssen zusammenpassen: verschiebt sich eine
  `publishProgress`-Marke, gehört sie auch in `lib/steps.js`. `tests/steps.test.js` hält
  das für `DRAFT_STEPS` fest.

---

## 13. ToS-Hinweis

Vintends Nutzungsbedingungen verbieten automatisierte Interaktion. Manuelles
Löschen-und-Neueinstellen wird toleriert, automatisiertes Bulk-Relisting nicht — bis hin
zur Account-Sperre. Die Extension ist als Einzel-Item-Werkzeug für die eigene Session
konzipiert und sollte sparsam genutzt werden.
