# Konzept — Automatisierte Artikelerstellung (Auto-Listing)

**Aufsetzend auf:** Vinted Relist v0.46.0
**Status:** entschieden (14 Punkte, Grilling-Runden 1–4)
**Datum:** 2026-08-13
**Zugehörig:** ADR-0007, ADR-0008, Ergänzung zu `CONTEXT.md`

> ## Nachtrag 2026-08-25 (v0.116.0) — was gebaut wurde und was sich geändert hat
>
> Dieses Konzept ist **gebaut**, in Betrieb, und an echten Artikeln gelaufen. Es bleibt
> stehen, wie es entschieden wurde — ein Entscheidungsprotokoll, das man rückwirkend
> glättet, verliert genau den Wert, für den es geschrieben wurde. Drei Entscheidungen hat
> die Wirklichkeit korrigiert; sie sind unten an Ort und Stelle markiert:
>
> | § | Damals | Heute | Was es umgeworfen hat |
> |---|---|---|---|
> | 4.1 | Stufenmodell als sichtbarer Freischaltweg | Entwicklungslandkarte, nicht Oberfläche | Die Anzeige „Stufe 1" beantwortete eine Frage, die kein Nutzer hat. Sichtbar ist nur noch: scharf oder Trockenlauf. |
> | 5.3 | **Keine** Bounding-Box vom Modell | Die Artikelbox des Modells ist der zweite Zuschnitt-Durchgang | Auf dem ersten echten Inserat standen die Füße des Fotografen. Der Abschälung sind Schuhe genauso viel Objekt wie ein Ärmel — nur wer weiß, was ein Hoodie ist, kann das trennen. |
> | 5.4 | Das Modell prüft den fertigen Zuschnitt | Das Modell sieht **das ganze Foto** und sagt, wo der Artikel liegt | Die Abschälung warf auf einem echten Foto 74 % weg, darunter das Größenetikett. Das Modell meldete pflichtgemäß `size_label: null` — es hatte nichts zu lesen. |
>
> Dazu eine Entscheidung, die nicht umgeworfen, sondern **ergänzt** wurde: die Gegenprobe
> (Entscheidung C, §6.4) brauchte einen Ausweg. Eine ausdrückliche Wahl des Nutzers steht
> jetzt, auch wenn Vinted widerspricht — sonst wiederholt sich derselbe Einwand endlos, und
> der Kinderpullover, den Vinted für einen Herren-Sweater hält, ließe sich nie einstellen.
>
> Der heutige Stand steht in `docs/TECHNISCHE_DOKUMENTATION.md` §7.2 und in `README.md`.

---

## 1. Fachliche Anforderung

Aus Fotos einer Ware soll ohne manuelle Tipparbeit ein verkaufsfertiges Vinted-Inserat
entstehen.

| # | Anforderung | Priorität |
|---|---|---|
| A1 | Ware aus Fotos erkennen (Marke, Art, Größe, Farbe, Material) | muss |
| A2 | Fotos auf 4:5 / 1080×1350 normalisieren, **ohne das Objekt anzuschneiden** | muss |
| A3 | Titelschema **Marke · Art · Größe · Farbe** — verbindlich für Kleidung | muss |
| A4 | Beschreibungstext erzeugen | muss |
| A5 | Inserat auf Vinted erstellen | muss |
| A6 | Preis automatisch aus Vinteds Preisspanne (Mitte) | soll |
| A7 | Mehrere Artikel vorbereiten (Batch) | kann — optional |

Domäne: überwiegend Kleidung. Das ist relevant, weil Kleidung die einzige Warengruppe
ist, in der **Größe** ein Pflichtfeld mit kategorieabhängiger Wertemenge ist — der
technisch anspruchsvollste Teil des Vorhabens.

### Nicht-Ziele

- Kein vollautonomes Listing ohne Sichtprüfung.
- Kein Masseneinstellen mehrerer Artikel in kurzer Folge. Vinted drosselt das aktiv;
  ein Feature, das dagegen anrennt, scheitert konstruktionsbedingt. Batch bedeutet hier
  ausschließlich **Vorbereitung auf Vorrat**, nie gleichzeitiges Veröffentlichen (§8).
- Keine Unterstützung anderer Marktplätze.
- Keine automatische Zustandsbestimmung (§7.5).

---

## 2. Getroffene Entscheidungen

| # | Entscheidung | Abschnitt |
|---|---|---|
| 1 | Alles in der bestehenden Extension, keine separate Anwendung | §3 |
| 2 | `buildNewItemPayload()` als zweiter Builder, gemeinsame reine Helfer | §4.4 |
| 3 | Schreib-Sperre erst ab der schreibenden Phase | §4.5 |
| 4 | `draftCreateEnabled`, Default **aus**; eigenes Gate für den ersten scharfen Lauf | §8 |
| 5 | Jedes Bild KI-geprüft, gebündelt als **ein** Call pro Artikel | §5.4 |
| 6 | Glossar und ADR-0007 sofort, Umbenennung erst mit Stufe 3 | §11 |
| 7 | API-Key in `chrome.storage.local`, Prinzip in ADR-0007 präzisiert | §7.1 |
| 8 | Zuschnitt und KI-Call im Studio; Originale verlassen den Tab nie | §4.2 |
| 9 | `lib/draft-view.js` liefert das Render-Modell, Studio rendert nur | §4.3 |
| 10 | Studio bereitet vor, `draft/publish` an den SW veröffentlicht | §4.5 |
| 11 | AES-GCM mit Passphrase, Klartext-Key nur in `chrome.storage.session` | §7.1 |
| 12 | Upload-Fehler ist ein normaler Fehler; Warnung ab dem zweiten Versuch | §8 |
| 13 | Angeschnittenes Objekt wird markiert, der Nutzer entscheidet | §5.4 |
| 14 | Unsichere Felder blockieren bis bestätigt; Zustand mit „Sehr gut" vorbelegt | §6.4, §7.5 |
| 15 | Transport der Taxonomie-Reads bleibt offen bis zum Spike, injiziert | §4.2, §6.6 |
| 16 | Drafts speichern **nur Text**; Fotos leben im offenen Studio-Tab | §4.4 |
| 17 | KI schlägt Fotoreihenfolge mit Begründung vor, Umsortieren per Ziehen | §7.2 |
| 18 | Beschreibung: ein Satz plus 2–3 Fakten, Vorlage in den Einstellungen | §7.6 |
| 19 | Feste Sprachwahl, Default Deutsch; Warnung bei Domain-Abweichung | §7.7 |

---

## 3. Verortung: dieselbe Extension

Ein separater Agent wäre technisch möglich — ein echter Browser über CDP liefert einen
validen `Origin`, der Einwand aus ADR-0001 greift dort nicht. Er müsste aber
Auth-Beschaffung, Multipart-Transport und Fehlerklassifikation neu bauen, wäre gegenüber
Anti-Bot-Heuristiken auffälliger und brächte eine zweite Toolchain mit — gegen das
Projektprinzip „`npm run check` ist die ganze Toolchain".

Auch eine eigenständige Stufe-1-Anwendung (die ohne jeden Vinted-Call auskäme) wurde
verworfen: Stufe 3 braucht `title.js` und `crop.js` ohnehin in der Extension, und zwei
Kopien derselben Logik sind genau das Muster, das `gates.js` und ADR-0006 beseitigt
haben.

**Preis dieser Entscheidung:** Die Studio-UI wächst im Repo, das UI-Dateien bewusst nicht
unit-testet. Gegenmaßnahme ist Entscheidung 9 (§4.3).

---

## 4. Architektur

### 4.1 Stufenmodell

> **Überholt (v0.90.0).** Die Stufen waren eine Landkarte für die Entwicklung und sind als
> solche aufgegangen: 1 bis 3 sind gebaut, 4 nicht. Als *Oberfläche* waren sie ein Fehler —
> oben rechts im Studio stand „Stufe 1", während der Nutzer wissen wollte, ob sein Klick
> ein echtes Inserat erzeugt. Genau das steht dort jetzt, und sonst nichts.

| Stufe | Inhalt | Vinted-Kontakt |
|---|---|---|
| 1 | Zuschnitt, Erkennung, Titel, Text → Copy & Download | **keiner** |
| 2 | Taxonomie holen, IDs auflösen, nur anzeigen | nur lesend |
| 3 | Preis aus Vinteds Spanne, Create über die API | schreibend |
| 4 | Draft-Vorrat, Einzelfreigabe (optional) | schreibend |

Nach Stufe 1 ist das Werkzeug bereits produktiv nutzbar. Stufe 3 wird erst
freigeschaltet, wenn Stufe 2 über ~50 realen Artikeln eine belastbare Trefferquote
zeigt.

### 4.2 Laufzeitkontexte

Neu ist eine vierte Oberfläche: **Studio-Page** (`studio/studio.html`, eigener Tab via
`chrome.tabs.create`). Das Popup stirbt bei jedem Klick daneben und ist für Drag & Drop,
Vorschau und Review untauglich. Die Studio-Page ist — wie `popup/popup.js` — ein
ES-Modul und kann `lib/` direkt importieren.

```
┌───────────────────────────┐
│  Studio-Page (Tab)        │──► api.anthropic.com    (KI-Calls, direkt)
│  Intake · Canvas · Review │
│  importiert lib/*         │
└─────────┬─────────────────┘
          │ chrome.runtime.sendMessage
          │   draft/lookup   (lesend, Taxonomie + Preisspanne)
          │   draft/publish  (schreibend, ein Aufruf)
          ▼
┌───────────────────────────┐
│  Service Worker           │   bleibt dünn: Router + Token-Snooper
└─────────┬─────────────────┘
          │ chrome.tabs.sendMessage  api/call
          ▼
┌───────────────────────────┐
│  Content-Script im        │──► vinted.de/api/v2/…   (same-origin, Pflicht)
│  Vinted-Tab               │
└───────────────────────────┘
```

**Zuschnitt und KI laufen im Studio** (Entscheidung 8). Handyfotos sind 3–6 MB, ein
fertiges 1080×1350-JPEG rund 300 KB. Liefe der Zuschnitt im Service Worker, müssten die
Originale base64-kodiert durch `chrome.runtime.sendMessage`. So überquert nur das kleine
Ergebnis die Grenze, und zwar erst beim Veröffentlichen. Die Originalfotos verlassen den
Tab nie.

Vinted-Calls laufen unverändert ausschließlich über den Content-Script. ADR-0001 gilt.

**Offen: der Transport der lesenden Calls (Entscheidung 15).** ADR-0001 betrifft
ausdrücklich *state-changing* Requests. Ob Vinted auch GETs auf Kategoriebaum,
Markensuche und Preisspanne mit einem `chrome-extension://`-Origin akzeptiert, ist
ungeprüft — `host_permissions` deckt die Domains ab. Der Unterschied ist im Alltag
spürbar: Über den Content-Script braucht Stufe 2 einen **offenen Vinted-Tab**, direkt aus
dem Studio liefe die Vorbereitung ohne. Der Spike (§6.6) klärt das. Bis dahin bleibt
`draft/lookup` der Weg, und `taxonomy.js` bekommt die Transportfunktion als Parameter —
dann ist der Wechsel eine Zeile und kein Umbau.

### 4.3 Entscheidungen liegen in `lib/`, nicht im Studio

Das Review ist die eigentliche Absicherung des Features und läge in der einzigen Zone
ohne Unit-Tests. `gates.js` hat dasselbe Problem bereits gelöst: Die Entscheidung fällt
in `lib/`, die UI rendert nur.

`lib/draft-view.js` liefert deshalb ein vollständiges Render-Modell: welche Felder offen
sind, ob der Draft `incomplete` ist, welcher Titel herauskommt, welche Warnung zu welchem
Foto gehört, ob der Publish-Knopf freigegeben ist. Das Studio enthält keine einzige
Entscheidung — nur `textContent` und `appendChild`.

### 4.4 Neue Module

| Modul | Art | Verantwortung |
|---|---|---|
| `lib/crop.js` | **rein** (+ Canvas-Adapter) | Objektbox, Rahmenwahl, Padding |
| `lib/title.js` | **rein** | Titelbau je Profil, Kürzungsregeln |
| `lib/resolve.js` | **rein** | String → ID, Konfidenz, Ambiguitäten |
| `lib/price.js` | **rein** | Mitte der Spanne, Rundung, Untergrenze |
| `lib/draft-view.js` | **rein** | Render-Modell für das Studio |
| `lib/ai.js` | Adapter | Anthropic-Client, Prompt, Schema-Validierung |
| `lib/secret.js` | Adapter | Key ver-/entschlüsseln, Session-Cache |
| `lib/taxonomy.js` | Adapter | Kategorien/Marken/Farben/Größen holen + cachen; **Transport injiziert** |
| `lib/draft.js` | Orchestrator | Publish-Pipeline gegen `DraftPort` |
| `lib/draft-port.js` | Interface | Seam-Definition, wie `relist-port.js` |
| `lib/draft-store.js` | Adapter | Draft-Ablage in `chrome.storage.local` — **nur Text** |
| `studio/*` | UI | Intake, Canvas, Review — **nicht** unit-getestet |

In `item.js` kommt **`buildNewItemPayload()`** dazu (Entscheidung 2) — nicht einsynthetisches `src` durch `buildItemUploadPayload()`. ADR-0004 hält fest, dass Vinted die
Form der Leseantwort ohne Vorwarnung ändert; am 2026-08-12 ist genau das passiert. Ein
zweiter Builder verhindert, dass eine Änderung am *Lesen* das *Neuanlegen* mitreißt. Die
reinen Helfer (`conditionId`, `sizeId`, Attribut-Bag) teilen sich beide.

### 4.5 Nebenläufigkeit

`CONTEXT.md` garantiert bisher genau eine Pipeline gleichzeitig. Die Invariante wird
präzisiert: nicht „eine Pipeline", sondern **„ein schreibender Vorgang"**.

- Vorbereitung (Zuschnitt, KI, Textbau, `draft/lookup`) berührt Vinted nicht oder nur
  lesend und läuft frei — auch parallel zu einem Relist.
- Ab dem ersten Foto-Upload nimmt `draft/publish` dasselbe Lock, das `relist()` hält.

Damit bleibt kein Schritt lang genug, um an der 30-Sekunden-Lebensdauer des MV3-Workers
zu scheitern: Das Studio orchestriert die lange Vorbereitung, der Worker sieht nur einen
Aufruf mit einer Antwort. Fortschritt fließt wie gehabt über `chrome.storage.local`.

---

### 4.6 Was ein gespeicherter Draft enthält

`chrome.storage.local` hat ein Kontingent von rund 10 MB, und `unlimitedStorage` steht
nicht im Manifest. Bisher war das nie relevant — Verlauf und ein 500-Zeilen-Log sind
winzig. Ein Draft mit acht zugeschnittenen Fotos belegt base64-kodiert jedoch rund 3 MB;
ein Vorrat wäre beim dritten Artikel am Anschlag, und der Fehlerfall wäre ein
abgewiesener Schreibvorgang mitten in der Vorbereitung.

**Entscheidung 16: Ein gespeicherter Draft ist reiner Text** — erkannte Felder, Titel,
Beschreibung, Preis, aufgelöste IDs, Feldzustände. Die Fotos leben ausschließlich im
offenen Studio-Tab. Weder `unlimitedStorage` noch IndexedDB werden gebraucht.

Das trifft nur Stufe 4 und kostet dort das Neu-Ablegen der Bilder. Das Studio muss es
deutlich sagen, sonst wirkt es wie Datenverlust: *„Beim Schließen gehen die Bilder
verloren, Texte bleiben."*

---

## 5. Bildverarbeitung
### 5.1 Zielformat

1080 × 1350 (4:5), JPEG, Quality 0.9. Kein Hochskalieren: Ist die verfügbare Breite nach
dem Zuschnitt kleiner als 1080, wird nativ ausgegeben.

### 5.2 Leitregel: das Objekt wird nie angeschnitten

Nicht „auf 4:5 schneiden und hoffen", sondern: erst feststellen, wo das Objekt liegt,
dann nur nachweislich leere Ränder entfernen.

1. **Objektbox bestimmen.** Bild auf ~200 px herunterrechnen, Rand-Medianfarbe als
   Hintergrundreferenz, Zeilen und Spalten von außen nach innen abtragen, solange sie
   farblich nah am Hintergrund liegen *und* kaum Kantenenergie tragen.
2. **Sicherheitsrand** von 4 % je Kante addieren — Fransen, Kordeln, Träger und Schatten
   liegen knapp außerhalb dessen, was eine Schwellwertsuche als Objekt erkennt.
3. **4:5-Rahmen suchen, der die Box vollständig enthält.** Gibt es ihn, wird zentriert
   zugeschnitten; es fällt ausschließlich Hintergrund weg.
4. **Gibt es ihn nicht, wird gepaddet**, nicht geschnitten (Hintergrundfarbe, bei
   unklarem Hintergrund Weiß).
5. **Erkennung unsicher** (Box füllt > 95 % des Bildes, Hintergrund zu unruhig) → immer
   padden.

Der Fehlerfall ist bewusst asymmetrisch: im Zweifel zu viel Rand, nie ein fehlender
Ärmel.

### 5.3 Keine Bounding-Box vom Modell

> **Umgekehrt (v0.79.0).** Die Artikelbox des Modells ist heute der **zweite**
> Zuschnitt-Durchgang, und sie schlägt die Abschälung, wo es eine gibt.
>
> Was dagegen sprach, stimmt weiterhin: die Koordinaten sind ungefähr. Was übersehen wurde,
> ist, dass die Abschälung eine Annahme trifft, die schlicht falsch sein kann — *alles, was
> nicht Hintergrund ist, IST der Artikel*. Auf dem ersten echten Inserat standen unten die
> Füße des Fotografen im Bild. Die sind kein Hintergrund; keine Schwelle repariert das, weil
> Schuhe aus Sicht der Pixel ein völlig ordentliches Objekt sind. Nur wer weiß, wie ein
> Hoodie aussieht, kann sagen: *das da unten gehört nicht dazu.*
>
> Die Ungenauigkeit wird stattdessen eingepreist. `modelBoxVerdict` lehnt jede
> unplausible Box ab (außerhalb, entartet, zu klein für ein brauchbares Inseratsbild, ganz
> in der Füllung), und eine mit dem Auge gezeichnete Box bekommt einen Zuschlag von 6 % —
> **der Box**, nicht des Bildes, weil der Fehler mit dem Gegenstand wächst und nicht mit dem
> Foto. Wird die Box abgelehnt, steht der erste Durchgang. Die Zusage aus §5.2 bleibt
> unberührt: die Box läuft durch dasselbe `chooseFrame`.
>
> Der Rest des Absatzes gilt unverändert — deshalb ist die Abschälung immer noch da, immer
> noch deterministisch und immer noch gegen synthetische Pixelmatrizen geprüft.

Vision-Modelle geben Koordinaten nur ungefähr an, und der Fehler liegt in genau der
Größenordnung, die hier weh tut. Die Heuristik ist deterministisch, kostenlos und
testbar — die Box-Bestimmung arbeitet auf einem Array und wird gegen synthetische
Pixelmatrizen geprüft, ohne Canvas.

### 5.4 Das Modell als Prüfer

> **Umgestellt (v0.79.0).** Das Modell bekommt nicht mehr den fertigen Zuschnitt zu sehen,
> sondern **das ganze Foto** — und der Zuschnitt folgt aus seiner Antwort, statt ihr
> voranzugehen.
>
> Der Grund ist gemessen: auf einem echten Foto behielt die Abschälung 26 % des Bildes, und
> das Größenetikett lag in den 74 %, die sie wegwarf. Das Modell meldete daraufhin
> pflichtgemäß `size_label: null` — es hatte nichts zu lesen. Dem Erkenner unsere eigene
> Vermutung vorzulegen war die Reihenfolge verkehrt herum.
>
> Ein Call je Artikel bleibt es. Die Modellkopie ist das unbeschnittene Foto (bis 1568 px
> Kantenlänge), die Inseratskopie entsteht daneben aus demselben Rahmen.

Jedes zugeschnittene Bild wird nachgeprüft (Entscheidung 5) — **gebündelt als ein Call
pro Artikel**, nicht einer pro Bild. Alle Fotos gehen gemeinsam rein, zurück kommt ein
Array mit einem Urteil je Bild: ragt ein Teil des Objekts über den Rand?

Die vollständige Abdeckung ist gerade in der Anlaufphase richtig: Sie liefert die Daten,
mit denen die Schwellwerte aus §5.2 kalibriert werden. Selektive Prüfung würde
ausgerechnet die Fälle ausblenden, in denen die Heuristik sich fälschlich sicher war.
Später über eine Einstellung auf Zweifelsfälle reduzierbar.

**Bei einem Befund entscheidet der Nutzer** (Entscheidung 13): Das Studio markiert das
Bild und bietet Padding, manuelle Korrektur oder Neuaufnahme an. Kein stiller
Automatik-Rückfall — sonst bliebe unsichtbar, wie oft die Heuristik danebenliegt. Das
Urteil wandert zusätzlich ins Log, damit die Trefferquote auswertbar ist.

### 5.5 EXIF-Orientierung

Der kritische Punkt bei Handyfotos:

```js
const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
```

Das bestehende `reencode()` setzt diese Option nicht — für den Relist-Pfad irrelevant,
weil CDN-Bilder normalisiert sind, für lokale Fotos zwingend. Weil der Canvas-Durchlauf
die Pixel physisch aufrichtet, gehen die Fotos danach mit `orientation: 0` in
`assigned_photos`; die Werte aus `photoOrientation()` dürfen hier **nicht** übernommen
werden.

Die Quality-Jitter aus `reencode()` entfällt — sie existiert nur, um Vinteds
Duplikat-Hashing beim Relist zu umgehen.

### 5.6 Schon im Original angeschnitten

Berührt die Objektbox den Bildrand, war der Artikel bereits beim Fotografieren nicht
vollständig im Bild. Dann hilft weder Zuschnitt noch Padding: Das Studio markiert das
Foto sichtbar („Objekt berührt den Bildrand — ggf. neu fotografieren").

---

## 6. Taxonomie und ID-Auflösung

### 6.1 Was aufgelöst werden muss

| Payload-Feld | Quelle | Schwierigkeit |
|---|---|---|
| `catalog_id` | Kategoriebaum | mittel |
| `brand_id` | Markensuche (live) | niedrig |
| `color1_id` | feste Farbliste | niedrig |
| `size_id` | **abhängig von `catalog_id`** | hoch |
| `status_id` | nie automatisch (§7.5) | — |
| `package_size_id` | feste Liste, aus Kategorie ableitbar | niedrig |
| `item_attributes` | kategorieabhängig | hoch |

### 6.2 Reihenfolge ist zwingend

`size_id` hängt an der Size-Group, die am `catalog_id` klebt — daher der Header
`X-Enable-Multiple-Size-Groups`. Also: erst Kategorie, dann die dafür gültige Größenmenge
holen, dann „M" darauf mappen. Dasselbe gilt für `item_attributes`; welche Attribute
Pflicht sind, wird zur Laufzeit erfragt, nicht hartkodiert (Lehre aus dem
`language_book`-Vorfall am 2026-08-12).

### 6.3 Die KI erfindet keine IDs

Zweistufig, strikt getrennt: Die KI liefert **nur Strings** plus Konfidenz;
`resolve.js` mappt deterministisch gegen die von Vinted geholten Kandidatenlisten
(Normalisierung → exakter Treffer → Alias-Tabelle → Fuzzy über Mindestschwelle).

Kein Treffer oder mehrere gleichwertige → Feld bleibt offen. Das entspricht ADR-0005 und
der Begründung in `conditionId()`.

### 6.4 Wann ein Feld die Veröffentlichung blockiert

Entscheidung 14: **Jedes Feld unterhalb der Konfidenzschwelle blockiert, bis der Nutzer
es bestätigt hat** — nicht nur fehlende Pflichtfelder. Ein per Fuzzy-Match gefundenes
`catalog_id` mit mittlerer Konfidenz ist genau der Fall, der beim schnellen Durchklicken
unbemerkt durchrutscht und einen falsch einsortierten Artikel erzeugt.

`draft-view.js` liefert je Feld einen Zustand: `ok` · `needs_confirmation` · `missing`.
Der Publish-Knopf gibt frei, wenn kein Feld mehr in den letzten beiden Zuständen ist.
Die Schwellwerte sind konfigurierbar und gehören kalibriert (§12).

### 6.5 Beschaffung der Tabellen

Die Lookup-Endpoints sind im Repo nicht abgebildet. Vorgehen wie bei der Create-Payload:
DevTools auf `/items/new`, Calls der SPA mitschneiden, Pfade und Antwortformen in
`docs/TECHNISCHE_DOKUMENTATION.md` dokumentieren. Caching in `chrome.storage.local` mit
TTL (Kategorien/Farben ~30 Tage; Größen je Kategorie on demand). Marken immer live.

### 6.6 Spike vor dem Bau

`ai_photo: false` in der Create-Payload deutet stark darauf hin, dass Vinted im
Upload-Flow eine eigene Fotoerkennung hat. **Vor** dem Bau von 6.1–6.5 gehört ein halber
Tag darauf verwendet, zu prüfen, was dieser Pfad zurückgibt. Liefert er `catalog_id` und
`brand_id`, schrumpft Stufe 2 auf einen Bruchteil.

Im selben Durchgang mitzuschneiden: der **Preisvorschlags-Endpoint** (§7.4). Seine
Eingabeparameter verraten nebenbei, welche Felder Vinted zu diesem Zeitpunkt erwartet.

Der Spike hat damit **drei Prüfpunkte**:

1. Was liefert Vinteds eigene Fotoerkennung im Upload-Flow?
2. Pfad, Eingabe und Antwortform des Preisvorschlags.
3. Akzeptiert Vinted lesende Calls (Kategoriebaum, Markensuche, Preisspanne) mit einem
   `chrome-extension://`-Origin? Davon hängt ab, ob die Vorbereitung einen offenen
   Vinted-Tab braucht (§4.2) — im Alltag der spürbarste der drei Punkte.

---

## 7. KI-Anbindung, Titel, Preis, Zustand

### 7.1 Aufruf und Key-Ablage

Die KI-Calls laufen aus der Studio-Page direkt gegen `api.anthropic.com`. Nötig:
`https://api.anthropic.com/*` in `host_permissions` und der Header
`anthropic-dangerous-direct-browser-access: true`, sonst blockiert CORS.

**Prinzipienkonflikt und seine Auflösung (Entscheidung 7).** Die Doku sagt heute „kein
Backend, keine gespeicherten Zugangsdaten". Das Prinzip schützt die **Vinted-Session** —
kein Server, dem das Konto anvertraut wird. Ein eigener Drittanbieter-Key ist eine andere
Kategorie: Sein Verlust kostet Geld, nicht den Account. ADR-0007 formuliert das Prinzip
deshalb um zu: *„keine gespeicherten **Vinted**-Zugangsdaten, kein Backend im
Vinted-Pfad."*

**Verschlüsselung (Entscheidung 11).** `lib/secret.js`, ausschließlich mit WebCrypto —
keine Dependency, kein Build-Step, und unter Node ist `crypto.subtle` global, also
regulär unit-testbar:

- Einrichtung: Key + Passphrase → `PBKDF2` → `AES-GCM`. Im Storage liegt nur
  `{ salt, iv, ciphertext }`.
- Nutzung: Passphrase einmal pro Browser-Sitzung; der entschlüsselte Key lebt in
  `chrome.storage.session`, die beim Schließen des Browsers geleert wird und für
  Content-Scripts per Default nicht lesbar ist.
- Weil die KI-Calls im Studio laufen, verlässt der Klartext-Key den Tab nie.

Ausdrücklich **verworfen**: Verschlüsselung mit einem im Extension-Code liegenden
Schlüssel. Wer an den Storage kommt, kommt auch an den Code — das kostet ihn eine Minute
und erzeugt ein falsches Sicherheitsgefühl.

**Grenze, die ins ADR gehört:** Das schützt gegen späteren Zugriff auf Profilverzeichnis
oder Backup. Es schützt *nicht* gegen jemanden, der vor dem entsperrten Rechner sitzt —
der öffnet das Studio und nutzt den Key durch den Nutzer hindurch.

**Der wirksamere Hebel steht daneben:** ein eigener Key nur für dieses Projekt plus ein
hartes Ausgabelimit im Anthropic-Konto. Verschlüsselung senkt die Wahrscheinlichkeit,
das Limit begrenzt den Schaden.

### 7.2 Prompt-Design

Ein Erkennungs-Call pro Artikel, alle Fotos als Base64 im selben Request, vorher auf
~1024 px längste Kante herunterrechnen. Strukturierte Ausgabe über Tool-Use mit
JSON-Schema, nicht über „antworte nur mit JSON".

```json
{
  "brand": "Nike",           "brand_confidence": 0.9,
  "type": "Hoodie",          "type_confidence": 0.95,
  "size_label": "M",         "size_source": "label_photo",
  "category_group": "clothing",
  "colors": ["schwarz", "weiß"],
  "material": "Baumwolle",
  "description": "…",
  "photo_order": [
    { "index": 2, "role": "Gesamtansicht vorn" },
    { "index": 0, "role": "Rückseite" },
    { "index": 1, "role": "Etikett" }
  ],
  "notes": ["Etikett unscharf, Größe unsicher"]
}
```

`size_source` ist wichtig: eine vom Etikett abgelesene Größe ist belastbar, eine aus
Proportionen geschätzte nicht. Nur erstere darf ohne Rückfrage übernommen werden.
Fehlende Erkennung ist `null`, nicht geraten — das gehört in den Systemprompt.

**Fotoreihenfolge (Entscheidung 17).** Vinted zeigt das erste Foto in der Trefferliste;
es entscheidet mit, ob überhaupt jemand klickt. Die KI schlägt die Reihenfolge vor und
begründet jedes Bild in zwei, drei Worten. Das Studio zeigt sie als sortierbare Reihe mit
sichtbar markiertem Titelbild; Umsortieren ist ein Ziehen, keine Bestätigung — anders als
bei den Feldern aus §6.4 richtet ein suboptimales Titelbild keinen Schaden an, es kostet
nur Klicks.

Die Begründungen haben einen zweiten Nutzen: Sie machen sichtbar, ob die KI die Fotos
überhaupt richtig versteht. Nennt sie ein Etikettfoto „Gesamtansicht", ist auch der
erkannten Größe nicht zu trauen.

Der Prüf-Call aus §5.4 ist ein zweiter, separater Aufruf mit den fertigen Bildern.

### 7.3 Titel: deterministisch, mit Profilen

Die Anforderung „Titel enthält immer Marke, Art, Größe, Farbe" lässt sich per Prompt
nicht garantieren. Die KI füllt Slots, **`title.js` baut den Titel**. Das feste Schema
gilt für Kleidung, nicht universell:

| Profil | Slots | Pflicht | Kürzungsreihenfolge |
|---|---|---|---|
| `clothing` | Marke · Art · Größe · Farbe | Marke, Art, **Größe** | Farbe zuerst |
| `shoes` | Marke · Art · Größe · Farbe | Marke, Art, **Größe** | Farbe zuerst |
| `accessories` | Marke · Art · Farbe · Material | Marke, Art | Material, dann Farbe |
| `media` | Titel · Autor/Marke · Format | Titel | Format zuerst |
| `generic` | Marke · Art · Modell · Farbe | Art | Farbe, dann Modell |

```js
// lib/title.js — rein, vollständig testbar
const SOFT_MAX = 60;   // Anzeige-Optimum: darüber schneidet die Trefferliste ab
const HARD_MAX = 100;  // Vinted-Limit: darüber lehnt die API ab

export function buildTitle(fields, profile = PROFILES.clothing, opts = {}) {
  const soft = opts.softMax ?? SOFT_MAX;
  const hard = opts.hardMax ?? HARD_MAX;
  const render = drop => profile.slots
    .filter(s => !drop.includes(s) || profile.required.includes(s))
    .map(s => fields[s]).filter(Boolean).join(' ');

  const dropped = [];
  let title = render(dropped);
  for (const slot of profile.dropOrder) {
    if (title.length <= soft) break;
    dropped.push(slot);
    title = render(dropped);
  }
  // Notbremse: reichen selbst die Pflicht-Slots über das API-Limit, wird an der
  // Wortgrenze geschnitten – ein abgelehnter Create ist schlimmer als ein kurzer Titel.
  if (title.length > hard) title = truncateAtWord(title, hard);
  return title;
}
```

**Zwei Grenzen, nicht eine.** 100 ist das API-Limit, 40–60 das Anzeige-Optimum. Für
Kleidung ist das entspannt: „Nike Hoodie M Schwarz" sind 21 Zeichen, „Tommy Hilfiger
Strickpullover XL Dunkelblau" 44.

**Nicht auf 40 Zeichen auffüllen.** Die 40 sind eine Beobachtung, keine Mindestlänge.
Füllwörter („TOP", „hochwertig") verdrängen nur Suchbegriffe.

Profilwahl: in Stufe 1 über `category_group` aus der KI (Fünf-Wege-Klassifikation), ab
Stufe 2 über die aufgelöste `catalog_id`. Ein fehlender Pflicht-Slot ist ein Blocker.

Nur die **Beschreibung** wird frei generiert.

### 7.4 Preis: Mitte von Vinteds Spanne

Vinteds Vorschlag stammt aus dessen eigenen Verkaufsdaten und ist die bessere Referenz
als alles selbst Errechnete.

**Regel:** `preis = runde(min + (max - min) / 2)`, kaufmännisch auf glatte 0,50 €.

1. **Erst ab Stufe 3 verfügbar** — die Spanne hängt an `catalog_id`, `brand_id`,
   `status_id`. In Stufe 1 zeigt Vinted sie im eigenen Formular.
2. **Keine Spanne → kein automatischer Preis.** Der Draft bleibt `incomplete`. Kein
   Rückfall auf einen Schätzwert.
3. **Immer übersteuerbar**, mit Untergrenzen-Setting („nie unter X €") gegen
   Fehlklassifikation: falsche Kategorie ⇒ falsche Spanne ⇒ Markenteil zum
   T-Shirt-Preis.
4. **Endpoint unbekannt** → Teil des Spikes (§6.6).

Einordnung: Vinteds Vorschlag optimiert auf Verkaufswahrscheinlichkeit, nicht auf Marge.
Die Mitte ist eine gute Voreinstellung für zügigen Abverkauf; bei überdurchschnittlichen
Stücken ist das obere Drittel klüger. Deshalb Voreinstellung, nicht Automatik.

### 7.5 Zustand: vorbelegt, aber bestätigungspflichtig

`status_id` wird **nie automatisch gesetzt**. Abnutzung ist aus Fotos unzuverlässig
erkennbar und die Angabe rechtlich bindend.

Entscheidung 14 ergänzt: Der Zustand wird mit **„Sehr gut"** vorbelegt — als
Cursor-Position, nicht als Angabe. Weil der Zustand als `needs_confirmation` gilt, gibt
der Publish-Knopf erst frei, wenn er aktiv bestätigt wurde.

Der bekannte Effekt gehört benannt: Eine Vorauswahl zieht. Wer schnell durchklickt,
landet systematisch bei „Sehr gut", auch bei Stücken, die eher „Gut" sind. Die erzwungene
Bestätigung ist das Gegengewicht — deshalb bleibt sie blockierend statt bloß markierend.

### 7.6 Beschreibung: ein Satz plus Fakten

**Entscheidung 18.** Ein Satz zum Stück, darunter zwei bis drei Fakten aus den erkannten
Feldern — Material, Passform, Besonderheiten wie Kapuze, Muster oder Verschluss. Das
Format liegt als Vorlage in den Einstellungen, damit es ohne Code-Änderung
nachjustierbar ist; die KI füllt sie, sie erfindet sie nicht.

Zwei Dinge bleiben ausdrücklich draußen:

- **Maße.** Aus Fotos nicht ablesbar. Eine erfundene Bundweite ist ein Sachmangel.
- **Zustandsprosa.** Der Zustand ist ein bestätigungspflichtiges Feld (§7.5); in Prosa
  wiederholt, könnte er unbemerkt vom gewählten Wert abweichen.

Der reine Fließtext wurde verworfen, weil er schlechter überfliegbar ist; die rein
strukturierte Form, weil alle Inserate dann gleich aussehen.

### 7.7 Sprache

**Entscheidung 19: feste Einstellung, Default Deutsch.** Die Texte entstehen in der
Vorbereitung, die Zieldomain steht erst beim Veröffentlichen fest — eine Ableitung aus
der Domain käme also zu spät, ohne die Zielseite schon im Studio zu wählen. Da der Verkauf
auf `vinted.de` stattfindet und `gates.js` ohnehin durchgehend deutsche Texte liefert, ist
die feste Einstellung das Ehrlichere.

Daraus folgt zwingend eine Prüfung, die keine eigene Entscheidung ist: Passt die
eingestellte Sprache nicht zur Domain, auf der veröffentlicht wird, warnt `draft/publish`
**vor** dem Foto-Upload. Ein deutscher Text auf `vinted.fr` ist nichts, was sich nach dem
Einstellen bequem repariert.

---

## 8. Sicherheit, Recht, Betriebsrisiko

**Trockenlauf (Entscheidung 4).** `draftCreateEnabled`, Default **false**. Im
Aus-Zustand läuft alles bis zur fertigen Payload, die wird ins Log geschrieben, der POST
unterbleibt. Damit ist Stufe 2 an echten Artikeln messbar, ohne dass je etwas
veröffentlicht wird. Der erste scharfe Lauf bekommt ein eigenes Gate in `gatesFor()` —
analog zum First-Run-Gate beim Löschen, mit `remember: true`.

**Fehlgeschlagener Create nach erfolgtem Foto-Upload (Entscheidung 12).** Wird als
normaler Fehler behandelt; ein Wiederholungsversuch lädt alles neu hoch mit frischer
`temp_uuid`. Fotos, die nie an einen Artikel gebunden wurden, hängen an einer temporären
Session und tauchen im Konto nicht auf — **verifiziert am 2026-08-21**, nach rund dreißig
verwaisten Uploads aus den Trockenläufen: der Kleiderschrank zeigt nur „Aktiv" und
„Verkauft" und keinen Entwurfs-Reiter, `/items/new` öffnet leer statt einen Entwurf
fortzusetzen, und Entwurfs-Endpunkte (`/api/v2/item_upload/drafts`, `/api/v2/drafts`)
gibt es nicht. Damit kostet ein zweiter Upload-Durchgang Zeit und Datenvolumen, aber er
hinterlässt nichts, was aufzuräumen wäre. Wächter: Nach dem zweiten Fehlversuch für denselben Draft warnt
das Studio, statt einen dritten Upload-Schwall loszuschicken. Wiederholtes Hochladen
identischer Bilder ist genau das Muster, gegen das die Anti-Bot-Hygiene sonst arbeitet.

**Sichtprüfung bleibt Pflicht.** Ein falsch beschriebenes Kleidungsstück ist ein
Sachmangel; die Haftung liegt beim Verkäufer, nicht beim Modell.

**Pacing — warum Batch-Upload kein Ziel ist.** Vinted drosselt das Einstellen mehrerer
Artikel in kurzer Folge aktiv. Vorbereitung darf beliebig parallel laufen;
Veröffentlichen bleibt Einzelvorgang mit manueller Auslösung. Die Cooldown-Zähler aus
`history.js` bewachen den Mindestabstand.

**AGB.** Automatisierter Zugriff bewegt sich in einer Grauzone; im schlechtesten Fall
steht die Account-Sperre im Raum. Das gilt für Relist bereits, das Risiko steigt mit dem
Volumen.

**Datensparsamkeit.** Die Fotos gehen an einen Drittanbieter. Hinweis im UI, dass
Hintergrund und mitfotografierte Personen dort landen; der Zuschnitt hilft, ersetzt den
Hinweis aber nicht.

---

## 9. Testkonzept

`lib/` liegt bei ~99 % Line-Coverage über 265 Tests. Neue Tests, mindestens:

**`title.test.js`** — Schema je Profil; Kürzung folgt der Profil-Reihenfolge und zielt
auf 60; Pflicht-Slots überleben jede Kürzung; **kein Ergebnis über 100 Zeichen**;
Notbremse schneidet an der Wortgrenze; fehlende Größe blockiert bei `clothing`, nicht bei
`media`.

**`crop.test.js`** — der wichtigste Test des Bildteils: **kein Rahmen schneidet je in die
Objektbox.** Dazu: Box + Sicherheitsrand passt → croppen; passt nicht → padden; Box
berührt den Bildrand → Warnung; unsichere Erkennung → padden; kein Upscaling. Box-
Bestimmung gegen synthetische Pixelmatrizen, ohne Canvas.

**`resolve.test.js`** — exakter Treffer schlägt Fuzzy; zwei gleichwertige Kandidaten
ergeben eine Ambiguität; unbekannter String ergibt `null` und nie eine geratene ID; Größe
wird nur gegen die Menge der gewählten Kategorie gematcht.

**`draft-view.test.js`** — Feldzustände `ok`/`needs_confirmation`/`missing`; der
Publish-Knopf gibt **nur** frei, wenn kein Feld mehr offen oder unbestätigt ist; der
vorbelegte Zustand zählt bis zur Bestätigung als `needs_confirmation`.

**`price.test.js`** — Mitte korrekt gerundet; fehlende Spanne ergibt `null`, nie einen
Schätzwert; Untergrenze greift; `min === max` ist zulässig.

**`secret.test.js`** — Round-Trip Ver-/Entschlüsselung; falsche Passphrase schlägt fehl
statt Müll zu liefern; ohne gesetzte Passphrase kein stiller Klartext-Fallback.

**`draft.test.js`** gegen einen `fake-port` nach dem Muster von `fake-port.js`: Ein Draft
mit offenem oder unbestätigtem Feld erreicht `createItem` **nie**; bei
`draftCreateEnabled: false` wird `createItem` nie aufgerufen. Das ist das Gegenstück zu
„`deleteItem` wird bei Fehlern oberhalb nie erreicht" und der wichtigste Test des
Features.

Nicht unit-getestet und bewusst so: die Canvas-Adapter und `studio/*`. Nach jeder
UI-Änderung einmal im Trockenlauf durchklicken.

---

## 10. Umsetzungsreihenfolge

| Schritt | Inhalt | Ergebnis |
|---|---|---|
| 0a | `CONTEXT.md` ergänzen, ADR-0007 schreiben | Vokabular steht, bevor Code entsteht |
| 0b | Spike: Vinteds Foto-Erkennung **und** Preis-Endpoint (§6.6) | Entscheidet Umfang von Stufe 2 und A6 |
| 1 | `crop.js` + Tests (Box, Rahmenwahl, Padding) | Objekt garantiert vollständig |
| 2 | `secret.js` + Einstellungen (Key, Passphrase) + Tests | KI-Zugang steht |
| 3 | Studio-Page: Intake, Vorschau, Review | UI steht |
| 4 | `ai.js` + `title.js` + `draft-view.js` + Tests | **Stufe 1 fertig, produktiv nutzbar** |
| 5 | `taxonomy.js` + `resolve.js` + Tests | IDs sichtbar, Trefferquote messbar |
| 6 | `draft.js` + `DraftPort` + `price.js` + `buildNewItemPayload` | **Stufe 3**, zunächst im Trockenlauf |
| 7 | Draft-Vorrat, Einzelfreigabe | **Stufe 4 — optional** |
| 8 | Umbenennung, README, Version 1.0 | Werkzeugkasten statt Relist-Tool |

Nach Schritt 4 ist das Werkzeug nützlich. Schritt 7 ist verzichtbar.

**Versionierung:** wie im Projekt üblich bei jeder Code-Änderung die Minor-Version in
`package.json` *und* `manifest.json` erhöhen.

---

## 11. Dokumentation

- **ADR-0007** (0006 ist vergeben: „Content scripts share globals; no bundler") hält die
  Verortungsentscheidung, die Key-Ablage und die Ablehnung der Alternativen fest.
- **`CONTEXT.md`** bekommt die neuen Begriffe *vor* der ersten Zeile Code: Draft, Studio,
  Objektbox, Rahmen, Profil, Feldzustand, Trockenlauf. Beim Gate-Thema sind die UIs
  auseinandergedriftet, weil dieselbe Sache zweimal unterschiedlich benannt wurde.
- **Umbenennung** der Extension erst mit Stufe 3 — bis dahin ist an der Außenwirkung
  nichts falsch, und ein Rename mitten in der Entwicklung erzeugt nur Diff-Rauschen.

---

## 12. Offene Punkte — alle brauchen Messwerte, keine Entscheidung

**Stand 2026-08-25 (v0.116.0).** Vier von sieben sind gemessen; die Antworten stehen
dahinter. Was offen geblieben ist, ist es aus demselben Grund wie am ersten Tag: es braucht
eine Messung, keine Überlegung.

1. ~~Pfade und Antwortformen der Taxonomie- und Preis-Endpoints sowie die Origin-Frage bei
   lesenden Calls.~~ **Gemessen** (Spike 0b, 2026-08-14). Vollständig in
   `docs/TECHNISCHE_DOKUMENTATION.md` §6. Kernbefund zur Origin-Frage: lesende Calls gehen
   direkt aus einer Extension-Page, sofern die Header stimmen — Addendum zu ADR-0001.
   Nachtrag: die **Sendungsgröße** läuft über einen anderen Host, verträgt keine
   CSRF-Header (CORS-Preflight) und braucht die `upload_session_id`; sie sitzt deshalb im
   Content-Script-Pfad und erst nach dem Upload.
2. **Teilweise.** Die Schwellwerte sind nicht mehr fest, sondern werden aus dem Bild selbst
   abgeleitet (Median und Streuung des Randrings), mit den Konstanten als Untergrenze — das
   löst den Fall „Kleidungsstück auf Holzboden", der mit festen Werten unlösbar war. Der
   Sicherheitsrand für die **Artikelbox des Modells** ist gemessen: 6 % *der Box*, nachdem
   ein Ärmel in die Bildkante lief. Die Werte für die Abschälung sind weiterhin nicht an
   30 Fotos kalibriert.
3. **Offen.** Die Grenze steht bei 0,8 und ist eine Setzung geblieben. Was sich stattdessen
   geändert hat: Konfidenz allein entscheidet nicht mehr. Ein Feld ohne Vinted-ID blockiert
   unabhängig davon, wie sicher das Modell war (`NEEDS_ID`) — der Durchrutscher, um den es
   in §6.4 geht, hing nicht an der Zahl, sondern daran, dass ein Name ohne ID gefüllt
   *aussieht*.
4. **Gemessen, mit einem anderen Ergebnis als erwartet.** Vinteds Stichwortsuche antwortet
   auf „Sweatshirt" mit *einem* Herren-Blatt — bei einem Kinderpullover also falsch, und
   zwar hartnäckig. Die Trefferquote war nicht das Problem, die Sackgasse war es: es gab
   keinen Weg, die Antwort zu überstimmen. Daher `browseCatalogs` (durch den Baum gehen
   statt raten) und `overriddenBy` (die eigene Wahl steht, auch gegen die Gegenprobe).
5. **Offen.** Ob Vinteds Preisspanne den Versand enthält, ist nicht geprüft. Dafür ist ein
   anderer Befund dazugekommen: die Spanne kommt nur, wenn Kategorie, Marke **und** Zustand
   stehen — und für ganze Kategoriefamilien (Bücher, Comics, Briefmarken, Schreibwaren) gibt
   es überhaupt keine Vergleichsverkäufe. Der leere Preis war deshalb kein Aussetzer,
   sondern vier verschiedene, jeweils ordentliche Lagen; sie stehen jetzt als Satz unter dem
   Feld.
6. **Offen, und bewusst zur sicheren Seite entschieden.** Ob Vinted Zeichen oder Bytes
   zählt, ist ungeprüft; `HARD_MAX` prüft deshalb **Bytes**. Ein etwas zu kurzer Titel ist
   besser als ein abgelehnter Create.
7. **Offen.** Ob verwaiste Fotos aus abgebrochenen Upload-Sessions im Konto sichtbar werden,
   ist nie beobachtet worden — es ist auch nie ein Lauf so abgebrochen, dass es aufgefallen
   wäre.

**Neu dazugekommen, und aus demselben Holz:** Ob **432 px** die richtige Untergrenze für
die Breite eines Inseratsbildes sind (`maxUpscale` in `crop.js`). Ein quadratisch
umrandetes Nackenetikett bei 1 % Bildfläche fällt heute heraus und behält den weiteren
Zuschnitt des ersten Durchgangs. Braucht ein echtes Foto zum Messen, keine Überlegung.
