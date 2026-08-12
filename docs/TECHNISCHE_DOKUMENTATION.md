# Technische Dokumentation — Vinted Relist

Chrome-Extension (Manifest V3), die einen Vinted-Artikel automatisiert **löscht und neu
einstellt** ("relist"/"bump"), um ihn in der Suche wieder nach oben zu bringen. Sie
arbeitet ausschließlich in der bestehenden Browser-Session des Nutzers — kein Backend,
keine gespeicherten Zugangsdaten.

> Diese Doku ergänzt das [Ablaufdiagramm](./ABLAUFDIAGRAMM.md). Die reverse-engineerten
> API-Details sind zusätzlich im Projekt-Memory hinterlegt.

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

Drei isolierte JS-Kontexte:

1. **Service Worker** (`background/`): hat Zugriff auf privilegierte APIs
   (`chrome.cookies`, `chrome.webRequest`, `chrome.scripting`, `chrome.tabs`), kann aber
   nicht same-origin gegen Vinted fetchen.
2. **Content-Script** (`content/`): läuft im Vinted-Tab, kann same-origin fetchen, hat
   aber nur eingeschränkte chrome.* APIs.
3. **Popup** (`popup/`): die UI, lebt nur solange das Popup offen ist.

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
