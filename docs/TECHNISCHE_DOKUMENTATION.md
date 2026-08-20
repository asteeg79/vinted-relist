# Technische Dokumentation — Vinted Relist

Chrome-Extension (Manifest V3), die einen Vinted-Artikel automatisiert **löscht und neu
einstellt** ("relist"/"bump"), um ihn in der Suche wieder nach oben zu bringen. Sie
arbeitet ausschließlich in der bestehenden Browser-Session des Nutzers — kein Backend,
keine gespeicherten Zugangsdaten.

> Diese Doku ergänzt das [Ablaufdiagramm](./ABLAUFDIAGRAMM.md). Die reverse-engineerten
> API-Details sind zusätzlich im Projekt-Memory hinterlegt.

> **Zweite Pipeline:** Das Auto-Listing (Artikel aus Fotos erstellen) hat ein eigenes
> Konzept — [KONZEPT_AUTO_LISTING.md](./KONZEPT_AUTO_LISTING.md), Verortung und Key-Ablage
> in [ADR-0007](./adr/0007-auto-listing-second-pipeline.md), Umsetzung in
> [IMPLEMENTIERUNGSPLAN_AUTO_LISTING.md](./IMPLEMENTIERUNGSPLAN_AUTO_LISTING.md). Das
> Prinzip „kein Backend, keine gespeicherten Zugangsdaten" oben ist dort präzisiert zu
> „keine gespeicherten **Vinted**-Zugangsdaten, kein Backend im Vinted-Pfad": der eigene
> Anthropic-Key liegt verschlüsselt im Extension-Storage.

---

## 1. Inhaltsverzeichnis

1. Überblick & Designprinzipien
2. Verzeichnis- & Modulstruktur
3. Laufzeit-Kontexte und Kommunikation
4. Authentifizierung (CSRF, anon_id, Cookies)
5. Vinted-API-Referenz
6. Die Relist-Pipeline im Detail
7. Speicher (chrome.storage.local)
8. Einstellungen
9. Sicherheitsnetze
10. Build, Validierung & Tests
11. Bekannte Grenzen & Wartung
12. ToS-Hinweis

---

## 2. Überblick & Designprinzipien

- **Manifest V3**, Service Worker als ES-Modul.
- **Modulare Architektur:** reine Logik (testbar) ist von chrome.*-I/O getrennt; der
  Service Worker ist nur ein dünner Message-Router.
- **create-then-delete:** Der neue Artikel wird immer zuerst erstellt (und optional
  verifiziert), das Original erst danach gelöscht.
- **Origin-Treue:** State-changing API-Calls laufen im Page-Kontext eines echten
  Vinted-Tabs (Content-Script), damit Vintends CSRF-/Origin-Prüfung sie akzeptiert.
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
│   ├── content.js             (1) API-Proxy  (2) Wardrobe-Enhancer (Relist-Button+Toast)
│   └── inject.css             Styles für injizierte UI (vr-* Klassen)
├── popup/
│   ├── popup.html/.css/.js    Popup-UI: URL, Warnungen, Progress, Verlauf, Settings
├── lib/                       Geschäftslogik (ES-Module)
│   ├── domains.js             Vinted-Hostliste + Match-Patterns + isVintedHost()
│   ├── util.js                sleep, jitter, uuidV4, arrayBufferToBase64
│   ├── errors.js              AuthError, ApiError, RateLimitError, ValidationError
│   ├── item.js                parseUrl, buildItemUploadPayload, extractInterest, …
│   ├── settings.js            DEFAULT_SETTINGS, get/save/reset
│   ├── history.js             Relist-Verlauf + getCounts (1h/24h)
│   ├── progress.js            setProgress/clearProgress (storage)
│   ├── logger.js              log/clearLog (500-Zeilen Ring-Buffer)
│   ├── auth.js                Token-Snooping, CSRF-Scrape, Sessions, ensureAuth
│   ├── page-api.js            API-Calls via Content-Script (fetch/upload/create/delete)
│   ├── image-utils.js         fetchAsBlob, reencode (OffscreenCanvas)
│   ├── retry.js               withRetry (Backoff für 429/5xx)
│   └── relist.js              Pipeline-Orchestrierung: relist() + preflight()
├── scripts/
│   └── validate.mjs           Manifest-/Syntax-/ESM-Import-Checks
├── tests/                     node:test Suite (+ chrome-mock Helper)
└── docs/                      diese Doku + Ablaufdiagramm
```

### Modul-Verantwortlichkeiten (Kurzreferenz)

| Modul | Exporte (Auswahl) | Zweck |
|---|---|---|
| `domains.js` | `VINTED_HOSTS`, `tabMatchPatterns`, `apiMatchPatterns`, `isVintedHost` | Single Source of Truth für Domains |
| `util.js` | `sleep`, `jitter`, `uuidV4`, `arrayBufferToBase64` | Reine Helfer |
| `errors.js` | `AuthError`, `ApiError`, `RateLimitError`, `ValidationError` | Typisierte Fehler für Branching |
| `item.js` | `parseUrl`, `buildItemUploadPayload`, `extractInterest`, `pickPhotoUrl`, `photoOrientation` | Reine Daten-Transformationen |
| `settings.js` | `DEFAULT_SETTINGS`, `getSettings`, `saveSettings`, `resetSettings` | Persistente Einstellungen |
| `history.js` | `getHistory`, `addEntry`, `clearHistory`, `getCounts` | Verlauf + Cooldown-Zähler |
| `progress.js` | `setProgress`, `clearProgress` | Fortschritt publizieren |
| `logger.js` | `log`, `clearLog` | Diagnose-Log |
| `auth.js` | `extractTokensFromHeaders`, `extractCsrfFromHtml`, `saveLiveTokens`, `getLiveTokens`, `saveSession`, `getSession`, `readCookies`, `fetchCsrfFromHtml`, `ensureAuth` | Auth-Beschaffung |
| `page-api.js` | `fetchItemViaPage`, `uploadPhotoViaPage`, `createItemViaPage`, `deleteItemViaPage` | API über Content-Script |
| `image-utils.js` | `fetchAsBlob`, `reencode` | Foto-Download + Re-Encoding |
| `retry.js` | `withRetry` | Wiederholung bei 429/5xx |
| `relist.js` | `relist`, `preflight` | Pipeline |

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

**Message-Protokoll** (`chrome.runtime.onMessage`):

| Typ | Von → Nach | Payload | Antwort |
|---|---|---|---|
| `session/update` | Content → SW | `{domain, csrf, anonId, vUdt, vUid}` | `{ok}` |
| `relist/preflight` | Popup/Content → SW | `{url}` | `{ok, title, photoCount, interest, counts}` |
| `relist/run` | Popup/Content → SW | `{url}` | `{ok, ...result}` |
| `api/call` | SW → Content | `{method, path, headers, json?\|multipart?}` | `{ok, status, contentType, body}` |

Fortschritt fließt **nicht** per Message, sondern über `chrome.storage.local.progress`
(Publish/Subscribe): Popup und Toast hören via `chrome.storage.onChanged`.

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
| Pflichtfelder je Kategorie | `GET` | `/api/v2/offline_verification/criteria/{catalog_id}` | `{required_field_codes: ["brand","price"], code}` |
| Attribute je Kategorie | `POST` | `/api/v2/item_upload/attributes` | `{attributes: [{code, value_ids, value, configuration}], code}` |
| Marken je Kategorie | `GET` | `/api/v2/item_upload/brands?category_id={id}` | `{brands: [{id, title, requires_authenticity_check, is_luxury, is_hvf, has_children}], disable_custom_brands, code}` — 50 beliebte |
| Farben | `GET` | `/api/v2/item_upload/colors` | `{colors: [{id, title, hex, order, code}], code}` — 29 Stück |
| **Preisvorschlag** | `GET` | `/api/v2/item_price_suggestions?catalog_id=&brand_id=&status_id=` | siehe unten |
| Paketgrößen je Kategorie | `GET` | `/shipping-estimation/external/catalogs/{catalog_id}/package_sizes` | `{package_sizes, parcel_measurements, …}` |
| Paketgröße vorschlagen | `POST` | `/shipping-estimation/external/package_sizes/suggestion` | `{package_size_id}` |
| Kategorie aus Fotos | `POST` | `/api/v2/item_upload/suggestions/categories` | `{categories: […], prefill_categories: […], legacy_first_category, code}` |
| Marke/Farbe aus Fotos | `POST` | `/api/v2/item_upload/suggestions/attributes` | `{brands, colors, sizes, isbn, dynamic_attributes, code}` |

Ein Kategorie-Knoten ist `{id, title, restricted_to_status_id, badge, photo, path, catalogs[]}`.
Blätter haben `catalogs: []`. Der Baum trägt **keine** Größengruppe — die kommt aus
`POST /api/v2/item_upload/attributes` mit `{attributes:[{code:"category", value:[<id>]}]}`;
für Kleidung antwortet er mit sechs Deskriptoren (Marke, Größe, Zustand, Farbe, Material,
Maße). Das ist die Reihenfolge aus §6.2 des Konzepts, von Vinted selbst erzwungen: erst
Kategorie, dann die dafür gültige Größenmenge.

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
  in der Vorbereitung zur Verfügung, nicht erst nach dem Upload — Anforderung A6 fällt
  damit in Stufe 2 statt Stufe 3.
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
- **Stufe 2 braucht keinen offenen Vinted-Tab.** Taxonomie, Markensuche und Preisspanne
  kann das Studio selbst holen; `taxonomy.js` bekommt `fetch` als Transport injiziert
  (Entscheidung 15 im Auto-Listing-Konzept). Die Nachricht `draft/lookup` wird dafür nicht
  gebraucht.
- **Der Auth-Bundle muss trotzdem vorliegen.** Die Tokens stammen aus dem
  webRequest-Snooping des Service Workers und werden pro Domain persistiert — ein einmal
  besuchter Vinted-Tab genügt, ein *offener* nicht.
- **Für schreibende Calls ändert das nichts.** ADR-0001 bleibt unangetastet: der Create
  wurde in diesem Versuch **nicht** getestet, und die CSRF-/Origin-Prüfung beim Schreiben
  ist genau der Punkt, an dem der SW-`fetch` seinerzeit scheiterte. Fotos hochladen und
  Artikel erstellen laufen weiter über den Content-Script.

---

## 7. Die Relist-Pipeline im Detail

Siehe [Ablaufdiagramm §2](./ABLAUFDIAGRAMM.md#2-relist-pipeline-hauptablauf). Phasen &
Fortschritt:

| % | Phase | Funktion |
|---|---|---|
| 2 | Auth prüfen | `ensureAuth` |
| 10 | Artikel laden | `fetchItemViaPage` |
| 20–75 | Fotos: download → reencode → upload | `fetchAsBlob`, `reencode`, `uploadPhotoViaPage` |
| 80 | Artikel erstellen | `createItemViaPage` |
| 88 | Verifizieren (Backoff 1.5/2.5/4/5.5 s) | `verifyCreated` |
| 92 | Original löschen | `deleteItemViaPage` |
| 100 | Verlauf schreiben | `addEntry` |

**Rückgabeformen** von `relist()`:
- `{oldId, newId, newUrl}` — Erfolg (Original gelöscht).
- `{testMode, oldId, newId, newUrl, oldUrl}` — Test-Modus (Original behalten).
- `{partial, oldId, newId, newUrl, warning}` — Klon erstellt, Original **nicht** gelöscht
  (Verifikation/Owner/Löschen fehlgeschlagen).
- *throw* — harter Fehler vor Erstellung (Original unberührt).

---

## 8. Speicher (chrome.storage.local)

| Key | Form | Modul |
|---|---|---|
| `liveTokens` | `{ [domain]: {csrf, anonId, ts} }` | auth.js (Snooper) |
| `sessions` | `{ [domain]: {csrf, anonId, vUdt, vUid, ts} }` | auth.js |
| `settings` | siehe §9 | settings.js |
| `relistHistory` | `[{ts, oldId, newId, title, domain, testMode}]` (≤100) | history.js |
| `progress` | `{pct, step, ts}` | progress.js |
| `log` | `string[]` (≤500) | logger.js |
| `confirmedDelete` | `boolean` | popup/content |

---

## 9. Einstellungen

| Key | Default | Wirkung |
|---|---|---|
| `deleteEnabled` | `true` | `false` = Test-Modus, Original bleibt |
| `photoQuality` | `0.92` | JPEG-Qualität beim Re-Encoding (0.6–0.98) |
| `cooldownWarnPerHour` | `5` | Soft-Warnung ab N Relists/Stunde |
| `cooldownWarnPer24h` | `30` | Soft-Warnung ab N Relists/24 h |
| `interestWarn` | `true` | Warnung bei Favoriten/Aufrufen/Gesprächen |
| `verifyAfterCreate` | `true` | Klon vor dem Löschen re-fetchen |

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
- **Foto-Re-Encoding** mit Qualitäts-Jitter gegen Duplikat-Hashing.

---

## 11. Build, Validierung & Tests

Kein Build-Step — die Extension wird als „entpackte Erweiterung" geladen.

```bash
npm run validate   # manifest.json, JS-Syntax, ESM-Import-Graph (mit chrome/DOM-Stub)
npm test           # node:test Suite (86 Tests)
npm run coverage   # Coverage-Report
npm run check      # validate + test
```

**Coverage-Strategie:** Reine + Storage-Module via In-Memory-chrome-Mock
(`tests/helpers/chrome-mock.js`) auf ~98–100 %. Nicht unit-getestet (per Browser
end-to-end validiert): `relist.js` (Orchestrierung) und `image-utils.reencode`
(`OffscreenCanvas`, nur im Browser).

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

---

## 13. ToS-Hinweis

Vintends Nutzungsbedingungen verbieten automatisierte Interaktion. Manuelles
Löschen-und-Neueinstellen wird toleriert, automatisiertes Bulk-Relisting nicht — bis hin
zur Account-Sperre. Die Extension ist als Einzel-Item-Werkzeug für die eigene Session
konzipiert und sollte sparsam genutzt werden.
