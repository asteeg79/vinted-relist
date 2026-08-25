# Ablaufdiagramme — Vinted Relist

Diese Datei beschreibt die zentralen Abläufe der Extension. Die Diagramme sind in
[Mermaid](https://mermaid.js.org/) geschrieben (rendern auf GitHub automatisch); für
die Haupt-Pipeline gibt es zusätzlich eine ASCII-Variante.

---

## 1. Komponenten-Überblick

In welchem Kontext läuft welcher Code und wie kommunizieren sie.

```mermaid
flowchart LR
    subgraph Popup["Popup (popup.js)"]
        UI[URL-Eingabe · Buttons · Settings · Verlauf]
    end
    subgraph Studio["Studio-Tab (studio.js)"]
        PREP["Fotos → Zuschnitt → KI-Erkennung<br/>→ Felder bestätigen"]
    end
    subgraph Content["Content-Script (content.js)"]
        BTN["Relist-Button + Toast<br/>(Wardrobe-Enhancer)"]
        PROXY["API-Proxy<br/>(fetch im Page-Origin)"]
    end
    subgraph SW["Service Worker (background)"]
        ROUTER[Message-Router]
        SNOOP[webRequest Token-Snooper]
        PIPE["Relist-Pipeline (lib/relist.js)"]
        DPIPE["Publish-Pipeline (lib/draft.js)"]
    end
    subgraph Vinted["Vinted-Server"]
        API["/api/v2/..."]
    end
    subgraph Anthropic["api.anthropic.com"]
        AI["Foto → erkannte Felder"]
    end

    UI -- "relist/preflight · relist/run" --> ROUTER
    BTN -- "relist/preflight · relist/run" --> ROUTER
    PREP -- "draft/gates · draft/publish" --> ROUTER
    PREP -- "fetch (Key nur hier)" --> AI
    ROUTER --> PIPE
    ROUTER --> DPIPE
    PIPE -- "api/call (Message)" --> PROXY
    DPIPE -- "api/call (Message)" --> PROXY
    PROXY -- "fetch credentials:include" --> API
    API -. "X-CSRF-Token / X-Anon-Id" .-> SNOOP
    SNOOP -- "chrome.storage.local.liveTokens" --> PIPE
    PIPE -- "storage.local.progress {pct, step, steps}" --> UI
    PIPE -- "storage.local.progress {pct, step, steps}" --> BTN
    DPIPE -- "storage.local.progress {pct, step, steps}" --> PREP
```

**Kernidee:** Der Service Worker orchestriert, **fetcht aber nie selbst** gegen die
state-changing API. Jeder API-Call wird als `api/call`-Nachricht an das Content-Script
geschickt und dort ausgeführt — nur so stimmt der `Origin` (`https://www.vinted.de`),
den Vintends CSRF-Schutz verlangt.

**Zweite Kernidee (ADR-0007):** Vom Auto-Listing überquert nur die **schreibende** Hälfte
diese Naht. Zuschnitt, KI-Call und Feldbestätigung bleiben im Studio-Tab — der Worker
bekommt einen Aufruf und gibt eine Antwort, statt minutenlang zu leben. Die Originalfotos
und der entschlüsselte Anthropic-Key verlassen den Tab nie.

---

## 2. Relist-Pipeline (Hauptablauf)

```mermaid
flowchart TD
    A[Start: relist/run mit URL] --> B[Settings + Auth laden]
    B --> C{CSRF & anon_id<br/>vorhanden?}
    C -- nein --> CErr[Fehler: bitte einloggen] --> Z2
    C -- ja --> D["GET item_upload/items/{id}<br/>(volle Artikeldaten)"]
    D --> E{Fotos<br/>vorhanden?}
    E -- nein --> EErr[Fehler: keine Fotos] --> Z2
    E -- ja --> F[upload_session_id erzeugen]
    F --> G[Für jedes Foto:<br/>download → re-encode → upload]
    G --> H["POST item_upload/items<br/>(neuer Artikel)"]
    H --> I{Test-Modus?}
    I -- ja --> ITest[Original behalten<br/>History: testMode] --> Z1
    I -- nein --> J{verifyAfterCreate?}
    J -- ja --> K["Neuen Artikel re-fetchen<br/>(Backoff 1.5–5.5s)"]
    K --> L{Verifiziert<br/>& Fotos > 0?}
    L -- nein --> LPart[partial: Original behalten] --> Z2
    L -- ja --> M
    J -- nein --> M{Owner == ich?}
    M -- nein --> MPart[partial: Sicherheits-Abbruch] --> Z2
    M -- ja --> N["POST items/{id}/delete<br/>(Original löschen)"]
    N --> O{Löschen ok?}
    O -- nein --> OPart[partial: manuell löschen] --> Z2
    O -- ja --> P[History-Eintrag<br/>Erfolg] --> Z1

    Z1[["Erfolg / Teilerfolg<br/>→ neue Artikel-URL"]]
    Z2[["Abbruch<br/>Original bleibt erhalten"]]
```

### ASCII-Variante (kompakt)

```
relist/run(url)
   │
   ├─ getSettings()  +  ensureAuth(domain, itemId)
   │      └─ kein CSRF/anonId? ─────────────────────────► Fehler (Original bleibt)
   │
   ├─ [10%]  fetchItemViaPage           GET  /api/v2/item_upload/items/{id}
   │      └─ keine Fotos? ─────────────────────────────► Fehler
   │
   ├─ uploadSessionId = uuidV4()
   │
   ├─ [20–75%]  je Foto (sequentiell, mit Jitter):
   │      download (CDN) → reencode (OffscreenCanvas) → uploadPhotoViaPage
   │                                    POST /api/v2/photos  (+ photo[temp_uuid])
   │
   ├─ [80%]  createItemViaPage          POST /api/v2/item_upload/items
   │
   ├─ Test-Modus?  ── ja ──► Original behalten, History(testMode) ─► Erfolg
   │
   ├─ [88%]  verifyAfterCreate?  ── ja ──► re-fetch new item (Backoff 1.5/2.5/4/5.5s)
   │              └─ nicht verifizierbar / 0 Fotos ────► partial (Original bleibt)
   │
   ├─ [92%]  Ownership-Check (vUid == seller_id?)
   │              └─ Mismatch ─────────────────────────► partial (Sicherheits-Abbruch)
   │
   ├─ deleteItemViaPage                 POST /api/v2/items/{id}/delete
   │              └─ Fehler ───────────────────────────► partial (manuell löschen)
   │
   └─ [100%]  History-Eintrag (Erfolg) ─────────────────► Erfolg → neue Artikel-URL
```

**Sicherheitsprinzip:** *create-then-delete*. Der Klon wird immer **zuerst** erstellt
(und optional verifiziert), das Original erst **danach** gelöscht. Bricht irgendetwas
ab, behält der Nutzer sein Original — schlimmstenfalls gibt es kurz zwei Listings.

---

## 3. CSRF-/Auth-Beschaffung (`ensureAuth`)

```mermaid
flowchart TD
    A[ensureAuth] --> B["readCookies()<br/>anonId, vUdt, vUid"]
    B --> C{liveTokens<br/>vorhanden?}
    C -- "csrf/anonId" --> D[übernehmen]
    C -- nein --> E{Session<br/>gespeichert?}
    D --> F{csrf gesetzt?}
    E -- "csrf" --> F
    E -- nein --> F
    F -- ja --> Z[Session speichern + zurückgeben]
    F -- nein --> G["fetchCsrfFromHtml()<br/>/items/{id}/edit → /items/new → /member/{vUid}"]
    G --> Z
```

`liveTokens` werden passiv vom **webRequest-Snooper** befüllt: jedes Mal wenn die
Vinted-SPA selbst einen API-Call macht, liest die Extension dessen `X-CSRF-Token` und
`X-Anon-Id` aus den Request-Headern. Das ist die zuverlässigste Quelle, weil sie exakt
der aktiven Session entspricht.

---

## 4. On-Page „Relist"-Button (Content-Script)

```mermaid
sequenceDiagram
    participant U as Nutzer
    participant C as Content-Script
    participant SW as Service Worker
    U->>C: Klick „Relist" auf Item-Card
    C->>C: Single-Concurrency-Check (activeRun)
    alt erster Lauf
        C->>U: Dialog „Original wird gelöscht?"
    end
    C->>SW: relist/preflight(url)
    SW-->>C: { interest, counts, gates, steps }
    loop für jedes Gate (gates.js)
        C->>U: Warnung — erst Bestätigung, dann weiter
    end
    C->>SW: relist/run(url)
    SW-->>C: progress { pct, step, steps } (storage.onChanged) → Toast
    C->>U: Toast: Balken, laufende Meldung, Phasenliste (✓ ▸ ·)
    SW-->>C: Ergebnis { newId, newUrl | warning } + message
    C->>U: Toast „Fertig" + Link / Card ausgrauen
```

Die Warnungen formuliert das Content-Script nicht selbst: `preflight` liefert die
geordneten `gates`, und dieselbe Liste bekommt das Popup (`lib/gates.js`) — sonst driften
zwei Textfassungen auseinander. Die `steps` reisen aus demselben Grund mit: das
Content-Script ist ein klassisches Skript und kann `lib/steps.js` nicht importieren
(ADR-0006).

---

## 5. Storage-Schlüssel (chrome.storage.local)

| Key              | Beschreibung                                              | Erzeuger            |
|------------------|-----------------------------------------------------------|---------------------|
| `liveTokens`     | `{ [domain]: {csrf, anonId, ts} }` — gesnoopte Tokens     | webRequest-Snooper  |
| `sessions`       | `{ [domain]: {csrf, anonId, vUdt, vUid, ts} }`            | auth.js             |
| `settings`       | Nutzer-Einstellungen (siehe settings.js)                  | popup / settings.js |
| `relistHistory`  | Array der letzten ≤100 Läufe                              | history.js          |
| `progress`       | `{ pct, step, steps, ts }` — Fortschritt + Phasenliste    | progress.js, steps.js |
| `log`            | Ring-Buffer der letzten 500 Log-Zeilen                    | logger.js           |
| `confirmedDelete`| Flag: Erst-Bestätigung Löschen erledigt                   | confirmation.js     |
| `confirmedCreate`| Flag: Erst-Bestätigung Anlegen erledigt                   | confirmation.js     |
| `taxonomy`       | Kategorie-/Größen-Cache mit TTL                           | taxonomy.js         |
| `priceMemory`    | gemerkte Preise je Kategorie                              | price-memory.js     |
| `anthropicKey`   | verschlüsselter API-Key                                   | secret.js           |

Dazu in `chrome.storage.**session**`: `anthropicKeyPlain` — der entsperrte Key, nur für
die Dauer der Browser-Sitzung.
