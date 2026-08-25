# Implementierungsplan — Auto-Listing

> ## Status: abgearbeitet (Stand v0.116.0, 2026-08-25)
>
> **Diese Datei ist Historie, keine Arbeitsanweisung mehr.** Schritte 0a bis 11 sind
> gebaut, getestet und live an echten Artikeln gelaufen. Wer wissen will, wie das
> Auto-Listing heute funktioniert, liest `docs/TECHNISCHE_DOKUMENTATION.md` §7.2 und
> `README.md`; wer wissen will, *warum* es so entschieden wurde,
> `docs/KONZEPT_AUTO_LISTING.md`. Was unten steht, sagt, in welcher Reihenfolge es entstand
> — und an welchen Stellen die Wirklichkeit den Plan korrigiert hat.
>
> **Offen geblieben:**
>
> | Schritt | Stand |
> |---|---|
> | 12 — Draft-Vorrat | nicht gebaut. Bisher hat niemand einen zweiten Draft parken wollen. |
> | 13 — Umbenennung auf 1.0 | nicht gemacht. Die Extension heißt weiterhin „Vinted Relist". |
>
> **Wo der Plan danebenlag** (jeweils durch eine Messung an einem echten Artikel
> korrigiert, Einzelheiten in der technischen Doku):
>
> - Das **Stufenmodell** aus dem Konzept war eine Entwicklungslandkarte, keine
>   Nutzeroberfläche. Es stand eine Zeit lang oben rechts im Studio und beantwortete eine
>   Frage, die niemand hatte. Heute steht dort nur, ob scharf geschaltet ist.
> - Die **Gegenprobe** (Entscheidung C) brauchte einen Ausweg: eine ausdrückliche Wahl des
>   Nutzers muss stehen bleiben, sonst wiederholt sich derselbe Widerspruch endlos.
> - Die Modellkopie ist **das ganze Foto**, nicht der erste Zuschnitt — sonst warf die
>   Abschälung genau das Etikett weg, das die Erkennung lesen sollte.
> - `item_attributes` und `requiredFields` aus dem Katalog waren beide **nicht** brauchbar:
>   der Attribut-Endpunkt antwortet leer, `offline_verification/criteria` für jede Kategorie
>   gleich. Was eine Kategorie verlangt, sagt erst der abgelehnte Create.
> - Die Sendungsgröße läuft über einen **anderen Host** und braucht die `upload_session_id`,
>   existiert also erst nach dem Upload.
>
> ---

**Ursprüngliche Fassung, für Claude Code als Arbeitsanweisung geschrieben.** Aufruf im
Repo-Root war:

> „Arbeite `docs/IMPLEMENTIERUNGSPLAN_AUTO_LISTING.md` ab, Schritt N."

Grundlage: `docs/KONZEPT_AUTO_LISTING.md`, `docs/adr/0007-auto-listing-second-pipeline.md`,
`CONTEXT.md`. Bei Widerspruch gilt das Konzept, nicht diese Datei.

---

## 0. Arbeitsprotokoll

**Ein Schritt pro Durchlauf.** Nicht vorgreifen, nicht zwei Schritte bündeln. Nach jedem
Schritt anhalten und das Ergebnis zeigen.

**Reihenfolge in jedem Schritt:**

1. Betroffene bestehende Dateien lesen, bevor irgendetwas geschrieben wird.
2. Tests zuerst schreiben, dann die Implementierung.
3. `npm run check` ausführen. Rot ⇒ reparieren, nicht weitermachen.
4. Minor-Version in `package.json` **und** `manifest.json` erhöhen (Projektregel, gilt
   auch für reine Doku-Änderungen).
5. Ergebnis melden: geänderte Dateien, neue Tests, Testanzahl vorher/nachher.

**Anhalten und fragen statt raten.** Wenn ein Schritt einen Endpoint, ein Feldformat oder
einen Schwellwert braucht, der in Schritt 0b noch nicht ermittelt wurde: **STOP**. Keine
Vinted-Pfade erfinden, keine Antwortformen annehmen, keine Platzhalter-IDs.

### Projektinvarianten — nicht verletzen

| Regel | Quelle |
|---|---|
| Kein Bundler, keine Runtime-Dependencies, kein Build-Step | ADR-0006 |
| Content-Scripts enthalten **kein** `import`/`export` | ADR-0006, `validate.mjs` |
| State-changing Vinted-Calls nur über den Content-Script | ADR-0001 |
| Reine Logik in `lib/`, `chrome.*`-I/O in Adaptern, SW bleibt dünner Router | `service-worker.js` |
| Entscheidungen in `lib/`, UIs rendern nur | `gates.js` |
| Begriffe exakt wie in `CONTEXT.md` | `CONTEXT.md` |
| Nie eine ID raten — lieber `null` und Abbruch | ADR-0005, `conditionId()` |

### Zielbild

`lib/` bleibt vollständig unit-getestet (~99 % Line-Coverage). Jede neue Datei in `lib/`
bekommt Tests im selben Schritt. `studio/*` und die Canvas-Adapter sind die einzigen
Ausnahmen und werden von Hand durchgeklickt.

---

## Schritt 0a — Dokumentation einchecken

**Ziel:** Vokabular und Entscheidung stehen, bevor Code entsteht.

- `docs/KONZEPT_AUTO_LISTING.md` und `docs/adr/0007-auto-listing-second-pipeline.md`
  ablegen.
- Inhalt von `docs/CONTEXT-ergaenzung.md` **in** `CONTEXT.md` nach dem Abschnitt „Gates"
  einfügen; die Schnipsel-Datei danach löschen. Kein zweites Glossar.
- In `README.md` und `docs/TECHNISCHE_DOKUMENTATION.md` je eine Verlinkung ergänzen, wie
  ADR-0006 dort bereits referenziert wird.

**Fertig, wenn:** `npm run check` grün, `CONTEXT.md` enthält Draft, Studio, Objektbox,
Rahmen, Padding, Profil, Feldzustand, Trockenlauf, Titelbild.

---

## Schritt 0b — Spike (manuell, nicht automatisierbar)

**Diesen Schritt führt der Mensch aus.** Claude Code stoppt hier und fasst nur zusammen,
was gebraucht wird.

DevTools auf `/items/new`, Netzwerk mitschneiden. Drei Prüfpunkte:

1. **Vinteds eigene Fotoerkennung.** Was liefert der Upload-Flow bei einem hochgeladenen
   Foto zurück? Kommen `catalog_id` / `brand_id` mit? (Hinweis: `ai_photo: false` in der
   Create-Payload.)
2. **Preisvorschlag.** Pfad, Eingabeparameter, Antwortform der Spanne. Wird sie erst nach
   dem Foto-Upload geliefert? Enthält sie den Versand?
3. **Origin bei lesenden Calls.** Akzeptiert Vinted GETs auf Kategoriebaum, Markensuche
   und Preisspanne mit `chrome-extension://`-Origin? Davon hängt ab, ob die Vorbereitung
   einen offenen Vinted-Tab braucht.

**Ergebnis** in `docs/TECHNISCHE_DOKUMENTATION.md`, Abschnitt „Vinted-API-Referenz",
im Format der bestehenden Tabelle. Erst danach sind die Schritte 7–10 ausführbar.

---

## Schritt 1 — `lib/crop.js`

**Ziel:** 4:5-Rahmen, der das Objekt nie anschneidet. Reine Geometrie getrennt vom Canvas.

**Neue Datei `lib/crop.js`**, Exporte:

```js
// REIN – arbeitet auf einem Graustufen-Array, kein Canvas, kein DOM.
// pixels: Uint8ClampedArray (w*h), Werte 0–255
export function objectBox(pixels, w, h, opts) // → { x, y, w, h, certain: boolean }

// REIN – wählt den Rahmen oder entscheidet auf Padding.
export function chooseFrame(box, imgW, imgH, opts)
// → { mode: 'crop', x, y, w, h } | { mode: 'pad', w, h, offsetX, offsetY }

// REIN – Zielmaße ohne Hochskalieren.
export function targetSize(frameW, frameH) // → { w, h }   max 1080×1350

export const DEFAULTS = { safetyMarginPct: 0.04, bgTolerance: 24, edgeEnergy: 12,
                          maxBoxFillPct: 0.95, aspect: 4 / 5, maxW: 1080, maxH: 1350 };
```

**Regeln:**
- `objectBox` trägt Zeilen/Spalten von außen ab, solange sie farblich nah an der
  Rand-Medianfarbe liegen **und** kaum Kantenenergie tragen. Danach Sicherheitsrand von
  4 % je Kante addieren.
- `certain: false`, wenn die Box > 95 % des Bildes füllt oder der Hintergrund zu unruhig
  für eine stabile Referenz ist.
- `chooseFrame` gibt **nur dann** `crop` zurück, wenn der 4:5-Rahmen die Box vollständig
  enthält. Sonst immer `pad`. Bei `certain: false` immer `pad`.
- `targetSize` skaliert nie hoch.

**Tests `tests/crop.test.js`** — synthetische Pixelmatrizen, kein Canvas:
- **Der zentrale Test:** kein von `chooseFrame` gelieferter Crop-Rahmen schneidet je in
  die Objektbox. Über mehrere Bildformate.
- Box + Sicherheitsrand passt in 4:5 → `crop`.
- Passt nicht → `pad`, Originalbreite bleibt erhalten.
- `certain: false` → immer `pad`, auch wenn ein Crop rechnerisch möglich wäre.
- Box berührt den Bildrand → wird im Rückgabewert kenntlich gemacht.
- Quelle kleiner als 1080 breit → `targetSize` skaliert nicht hoch.
- Einfarbiges Bild ohne Objekt → `certain: false`, kein Absturz.

**Fertig, wenn:** Tests grün, `npm run check` grün, Version erhöht.

---

## Schritt 2 — `lib/title.js`

**Ziel:** Titel deterministisch bauen. Die Anforderung „immer Marke, Art, Größe, Farbe"
hängt an einem Test, nicht an einem Prompt.

**Neue Datei `lib/title.js`:**

```js
export const SOFT_MAX = 60;   // Anzeige-Optimum
export const HARD_MAX = 100;  // Vinted-Limit

export const PROFILES = {
  clothing:    { slots: ['brand','type','size','color'],            required: ['brand','type','size'], dropOrder: ['color'] },
  shoes:       { slots: ['brand','type','size','color'],            required: ['brand','type','size'], dropOrder: ['color'] },
  accessories: { slots: ['brand','type','color','material'],        required: ['brand','type'],        dropOrder: ['material','color'] },
  media:       { slots: ['work','author','format'],                 required: ['work'],                dropOrder: ['format'] },
  generic:     { slots: ['brand','type','model','color'],           required: ['type'],                dropOrder: ['color','model'] }
};

export function buildTitle(fields, profile = PROFILES.clothing, opts = {})
export function missingRequired(fields, profile) // → string[]
```

**Regeln:** Kürzen entlang `dropOrder` bis `SOFT_MAX`. `required`-Slots werden nie
entfernt. Reicht das Ergebnis über `HARD_MAX`, an der Wortgrenze abschneiden. Länge im
Zweifel gegen die **Byte**-Länge prüfen (Umlaute).

**Tests `tests/title.test.js`:**
- Vollständige Kleidungsfelder → alle vier Slots, korrekte Reihenfolge.
- Kürzung entfernt zuerst die Farbe, nie Marke/Art/Größe.
- **Kein Ergebnis über 100 Zeichen**, auch bei absurd langen Markennamen.
- Notbremse schneidet an der Wortgrenze, nicht mitten im Wort.
- `missingRequired` meldet fehlende Größe bei `clothing`, nicht bei `media`.
- Fehlende Slots erzeugen keine doppelten Leerzeichen.
- Nicht auf `SOFT_MAX` auffüllen: kurze Titel bleiben kurz.

---

## Schritt 3 — `lib/secret.js`

**Ziel:** API-Key verschlüsselt ablegen. Nur WebCrypto, keine Dependency.

```js
export async function encryptKey(plaintext, passphrase) // → { salt, iv, ciphertext }  (base64)
export async function decryptKey(record, passphrase)    // → string, wirft bei falscher Passphrase
export async function cacheKey(plaintext)               // chrome.storage.session
export async function readCachedKey()                   // → string | null
```

PBKDF2 → AES-GCM. Im `storage.local` liegt ausschließlich `{ salt, iv, ciphertext }`.
Der Klartext-Key geht nur nach `chrome.storage.session`.

**Ausdrücklich nicht bauen:** Verschlüsselung mit einem im Code liegenden Schlüssel.
Siehe ADR-0007, „Do not re-suggest".

**Tests `tests/secret.test.js`** (`crypto.subtle` ist unter Node global):
- Round-Trip: verschlüsseln → entschlüsseln ergibt das Original.
- Falsche Passphrase wirft, liefert nie Müll zurück.
- Zwei Verschlüsselungen desselben Keys ergeben unterschiedliche Chiffrate (Salt/IV).
- Kein stiller Klartext-Fallback, wenn keine Passphrase gesetzt ist.

---

## Schritt 4 — Einstellungen erweitern

**Ziel:** Alle neuen Schalter an einer Stelle, mit Defaults.

`lib/settings.js`, `DEFAULT_SETTINGS` ergänzen:

```js
draftCreateEnabled: false,        // Trockenlauf ist der Default
draftLanguage: 'de',
draftConditionDefault: 'very_good',
draftMinPrice: 0,                 // 0 = aus
draftConfidenceThreshold: 0.8,
draftDescriptionTemplate: '…',    // ein Satz + 2–3 Fakten
cropCheckMode: 'all'              // 'all' | 'uncertain'
```

Bedienelemente ins Popup, im Stil der bestehenden Autosave-Bindings. `secret.js`-Eingabe
(Key + Passphrase) gehört hierher.

**Tests:** bestehende `tests/settings.test.js` um die neuen Schlüssel erweitern —
Defaults greifen, Patches akkumulieren, `resetSettings` räumt auf.

---

## Schritt 5 — `lib/ai.js`

**Ziel:** Ein Erkennungs-Call pro Artikel. **Erkennung, Fotoreihenfolge und
Zuschnitt-Prüfung in einem Aufruf** (Entscheidung W1) — die Bilder sind dieselben, zwei
Calls wären doppelte Übertragung ohne Gegenwert.

```js
export function buildAnalysisRequest(images, opts) // rein: baut den Request-Body
export function parseAnalysis(responseBody)        // rein: validiert gegen das Schema
export async function analyse(images, opts)        // Adapter: fetch + die beiden oben
```

Aufruf gegen `https://api.anthropic.com/v1/messages`, Header
`anthropic-dangerous-direct-browser-access: true`. `api.anthropic.com` in
`host_permissions` ergänzen. Der Call läuft **im Studio**, nicht im Service Worker.

Bilder vor dem Versand auf ~1024 px längste Kante herunterrechnen. Strukturierte Ausgabe
über Tool-Use mit JSON-Schema, nicht über „antworte nur mit JSON".

**Antwortschema:**

```json
{
  "brand": "…", "brand_confidence": 0.0,
  "type": "…",  "type_confidence": 0.0,
  "size_label": "…", "size_source": "label_photo|estimated|none",
  "category_group": "clothing|shoes|accessories|media|generic",
  "colors": ["…"], "material": "…",
  "description": "…",
  "photo_order": [{ "index": 0, "role": "…", "cropped_off": false }],
  "notes": ["…"]
}
```

`cropped_off` je Bild ist die Zuschnitt-Prüfung. Nicht erkannt heißt `null`, nie geraten —
das gehört in den Systemprompt.

**Tests `tests/ai.test.js`** gegen aufgezeichnete Antworten, ohne Netz:
- Schema-konforme Antwort wird vollständig geparst.
- Schema-Verletzung wird **verworfen**, nicht teilweise übernommen.
- `null`-Felder überleben das Parsen als `null`, nicht als `""`.
- `buildAnalysisRequest` setzt Sprache und Beschreibungsvorlage aus den Settings.
- Kein API-Key im Request-Log.

---

## Schritt 6 — `lib/draft-view.js`

**Ziel:** Die gesamte Review-Logik liegt hier, damit sie testbar ist. Das Studio rendert
nur. Muster: `gates.js`.

```js
export const FIELD_OK = 'ok';
export const FIELD_NEEDS_CONFIRMATION = 'needs_confirmation';
export const FIELD_MISSING = 'missing';

export function draftView({ analysis, resolved, settings, confirmations, photos })
// → { title, fields: [{key,label,value,state,candidates?}],
//     photos: [{index,role,warning?}],
//     canPublish: boolean, blockers: string[] }
```

**Regeln:**
- Jedes Feld unterhalb `draftConfidenceThreshold` ist `needs_confirmation` — nicht nur
  fehlende Pflichtfelder.
- Der vorbelegte Zustand („Sehr gut") ist bis zur Bestätigung `needs_confirmation`.
- `canPublish` ist **nur** wahr, wenn kein Feld mehr `missing` oder
  `needs_confirmation` ist.
- Fotos mit `cropped_off: true` oder randberührender Box tragen eine Warnung; sie
  blockieren nicht, sondern werden markiert.

**Tests `tests/draft-view.test.js`:**
- Feldzustände korrekt aus Konfidenz und Anwesenheit abgeleitet.
- `canPublish` bleibt falsch, solange ein Feld unbestätigt ist — auch wenn nichts fehlt.
- Vorbelegter Zustand zählt bis zur Bestätigung als unbestätigt.
- Titel im View entspricht `buildTitle` mit dem passenden Profil.
- Ein Foto mit `cropped_off` erzeugt eine Warnung, aber keinen Blocker.

---

## Schritt 7 — Studio-Page

**Ziel:** Oberfläche. Enthält **keine Entscheidung** — nur Intake, Canvas-Aufruf,
Darstellung des Modells aus Schritt 6.

Dateien: `studio/studio.html`, `studio/studio.css`, `studio/studio.js` (ES-Modul, darf
`lib/` importieren — wie `popup/popup.js`), Öffnen per `chrome.tabs.create` aus dem Popup.

Teilschritte, einzeln durchklickbar:

1. **Intake** — Drag & Drop plus Dateiauswahl, Vorschau, maximale Fotozahl je Inserat
   respektieren (Wert aus Schritt 0b; bis dahin konservativ begrenzen und den Wert an
   **einer** Stelle als Konstante halten).
2. **Canvas-Adapter** `studio/canvas.js` — `createImageBitmap(blob, { imageOrientation:
   'from-image' })`, Zuschnitt bzw. Padding nach `chooseFrame`, Ausgabe JPEG q=0.9.
   Danach `orientation: 0` verwenden, **nicht** `photoOrientation()`.
   Keine Quality-Jitter — die existiert nur gegen Vinteds Duplikat-Hashing beim Relist.
3. **Analyse anstoßen**, Ladezustand, Fehlerbehandlung.
4. **Review** — Felder mit Zustandsfarbe, Bestätigen-Schaltflächen, sortierbare
   Fotoreihe mit markiertem Titelbild.
5. **Hinweistexte** — „Beim Schließen gehen die Bilder verloren, Texte bleiben." und der
   Datenschutzhinweis, dass Fotos an einen Drittanbieter gehen.

**Nicht unit-getestet.** Nach jeder Änderung im Trockenlauf durchklicken.

**Damit ist Stufe 1 fertig und produktiv nutzbar** — ohne einen einzigen Vinted-Call.

---

## Schritt 8 — `lib/taxonomy.js` und `lib/resolve.js`

> **Voraussetzung: Schritt 0b ist dokumentiert.** Ohne die Endpoints STOP.

**`taxonomy.js`** holt Kategoriebaum, Marken (live), Farben, Größen je Kategorie,
Paketgrößen. Cache in `chrome.storage.local` mit TTL (Kategorien/Farben ~30 Tage, Größen
on demand). **Die Transportfunktion wird injiziert** — der Spike entscheidet, ob direkt
aus dem Studio oder über `draft/lookup`. Ein Parameter, kein Umbau.

**`resolve.js`** — Entscheidung W2: Das Modell **wählt aus der Kandidatenliste**, statt
dass eine Alias-Tabelle deutsche Begriffe fuzzy mappt.

```js
export function exactMatch(label, candidates)        // rein: normalisierter Direkttreffer
export function validatePick(pickedId, candidates)   // rein: ID muss aus der Liste stammen
export function resolveOrder(analysis)               // rein: Kategorie vor Größe
```

**Ablauf:** Direkttreffer zuerst (billig, deterministisch). Nur bei Fehlschlag ein
zweiter, eng begrenzter Modell-Call mit der Kandidatenliste. Dessen Antwort geht durch
`validatePick` — **eine ID, die nicht in der Liste stand, wird verworfen**, nicht
übernommen. Damit bleibt die Invariante aus ADR-0005 erhalten, obwohl das Modell wählt.

**Reihenfolge ist zwingend:** erst `catalog_id`, dann die für diese Kategorie gültige
Größenmenge holen, dann die Größe mappen. Pflicht-`item_attributes` zur Laufzeit
erfragen, nie hartkodieren.

**Tests `tests/resolve.test.js`:**
- Direkttreffer schlägt den Modell-Call (der wird gar nicht erst nötig).
- `validatePick` verwirft eine ID, die nicht in der Kandidatenliste steht.
- Zwei gleichwertige Kandidaten → Ambiguität, kein Zufallsgriff.
- Größe wird nur gegen die Menge der gewählten Kategorie gematcht.
- `resolveOrder` liefert Kategorie vor Größe.

---

## Schritt 9 — `lib/price.js`

> **Voraussetzung: Preis-Endpoint aus Schritt 0b dokumentiert.**

```js
export function midpoint(range, opts) // rein → number | null
```

Mitte der Spanne, kaufmännisch gerundet. **Keine Spanne ⇒ `null`**, nie ein Schätzwert.
`draftMinPrice` als Untergrenze.

**Entscheidung W3:** Die Spanne wird zunächst mit dem **vorbelegten** Zustand geholt und
als vorläufig gekennzeichnet. Ändert sich der Zustand, wird neu geholt — **ein vom Nutzer
manuell überschriebener Preis wird dabei nicht überschrieben**, sondern behalten und
markiert.

**Tests `tests/price.test.js`:** Mitte korrekt gerundet; `min === max` zulässig; fehlende
Spanne → `null`; Untergrenze greift; manueller Preis überlebt ein Neuladen der Spanne.

---

## Schritt 10 — `buildNewItemPayload()`

In `lib/item.js` **neben** `buildItemUploadPayload()`, nicht statt dessen. Kein
synthetisches `src`-Objekt (ADR-0007). Gemeinsame reine Helfer (`conditionId`, `sizeId`,
Attribut-Bag) werden geteilt.

**Tests in `tests/item.test.js`:** Payload enthält alle Pflichtfelder; ein fehlendes
Pflichtfeld führt zu einem Wurf, nicht zu `undefined` in der Payload; `assigned_photos`
trägt `orientation: 0`; `ai_photo` wird gesetzt wie beim Relist-Pfad.

---

## Schritt 11 — `lib/draft.js`, `lib/draft-port.js`, Veröffentlichen

**Port** nach dem Muster von `relist-port.js`; Test-Doppel nach dem Muster von
`fake-port.js`.

**Pipeline:** Sprachprüfung → Fotos hochladen (gemeinsame `temp_uuid`) → Payload bauen →
`createItem` → Verlauf schreiben.

**Regeln:**
- Das Lock wird **erst ab dem ersten Foto-Upload** genommen, gemeinsam mit `relist()`.
  Vorbereitung läuft frei.
- Bei `draftCreateEnabled: false`: Payload ins Log, **kein** POST.
- Ein Draft, dessen View `canPublish: false` liefert, erreicht den Upload nie.
- Sprache passt nicht zur Zieldomain → Warnung **vor** dem Upload.
- Fehlgeschlagener Create nach erfolgtem Upload ist ein normaler **Fehler**; kein
  Partial. Wiederholung lädt mit frischer `temp_uuid` neu hoch. Ab dem zweiten
  Fehlversuch für denselben Draft warnt das Studio, statt einen dritten Upload-Schwall
  zu starten.
- Neues Gate in `gates.js` für den ersten scharfen Lauf, `remember: true`.

**Nachrichten:** `draft/publish` (schreibend), `draft/lookup` (lesend, falls Schritt 0b
den direkten Weg ausschließt). Router in `background/service-worker.js` ergänzen, dünn
halten.

**Tests `tests/draft.test.js`** gegen den Fake-Port — der wichtigste Test des Features:
- Ein Draft mit offenem oder unbestätigtem Feld erreicht `createItem` **nie**.
- Bei `draftCreateEnabled: false` wird `createItem` **nie** aufgerufen.
- Sprach-Abweichung stoppt **vor** dem ersten Upload.
- Fehler beim Create hinterlässt keinen Partial-Zustand im Verlauf.

---

## Schritt 12 — Draft-Vorrat (optional)

`lib/draft-store.js`, **nur Text** — Felder, Titel, Beschreibung, Preis, IDs,
Bestätigungen. Keine Fotos: `chrome.storage.local` hat rund 10 MB, ein Draft mit acht
Fotos belegt base64 rund 3 MB, und `unlimitedStorage` steht bewusst nicht im Manifest.

Veröffentlichen bleibt Einzelvorgang mit manueller Auslösung. Kein Stapelversand.

---

## Schritt 13 — Umbenennung und 1.0

Name und Beschreibung in `manifest.json`, `package.json`, `README.md` auf den
Werkzeugkasten umstellen. Version 1.0.0. Erst jetzt, nicht früher.

---

## Was nicht gebaut wird

- Kein Bundler, keine npm-Runtime-Dependency, kein Build-Step.
- Kein Node-Agent, kein Backend, kein Proxy für die KI.
- Kein separates Stufe-1-Werkzeug außerhalb der Extension.
- Keine Verschlüsselung mit im Code liegendem Schlüssel.
- Keine automatische Zustandsbestimmung aus Fotos.
- Keine Maße in der Beschreibung.
- Kein Stapel-Upload mehrerer Artikel in kurzer Folge.
- Keine geratene ID, kein geschätzter Preis, kein Platzhalter-Endpoint.
