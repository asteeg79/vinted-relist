# Debug-Cheat-Sheet

Rezepte zum Kopieren. Die meisten laufen in der **Service-Worker-Konsole**, einige im
**Vinted-Tab**, einige im **Studio-Tab** — es steht jeweils dabei, denn die vier Kontexte
sehen verschiedene Dinge.

So kommst du in die SW-Konsole:

1. `chrome://extensions` → bei „Vinted Relist" auf **Service Worker** klicken. Steht dort
   „(inactive)", einmal das Extension-Icon anklicken — dann wacht er auf.
2. Ein eigenes DevTools-Fenster mit **Console**, **Network**, **Sources**.

> **Der Service Worker fetcht nicht gegen Vinted.** Sein Network-Tab bleibt bei Vinted-Calls
> leer — die laufen im Vinted-Tab (ADR-0001). Wer Requests sehen will, schaut dort.

## 0. Vor jedem Live-Test

```bash
npm run check     # validate + alle Tests in einem Rutsch
```

Rot? Nicht in Chrome laden — erst hier reparieren.

Und nach dem Laden: **Version prüfen.** Sie steht in beiden Oberflächen und im Log. Der
häufigste „Fehler" ist ein nicht durchgeführter Reload.

```js
chrome.runtime.getManifest().version;
```

## 1. Was liegt im Speicher?

```js
// SW-Konsole. Alles auf einmal:
chrome.storage.local.get(null).then(s => console.log(Object.fromEntries(
  Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? `${v.length} Einträge` : v])
)));
```

Die Schlüssel und was sie bedeuten, stehen in `docs/TECHNISCHE_DOKUMENTATION.md` §8. Kurz:

| Schlüssel | wofür |
|---|---|
| `liveTokens` / `sessions` | CSRF + anon-id je Domain |
| `settings` | die Einstellungen inkl. `deleteEnabled` und `draftCreateEnabled` |
| `progress` | `{pct, step, steps}` — der laufende Fortschritt |
| `log` | Ringpuffer, 500 Zeilen |
| `taxonomy` / `priceMemory` | Caches des Auto-Listings |
| `anthropicKey` | verschlüsselt; der Klartext liegt in `storage.**session**` |

## 2. Bin ich angemeldet?

Der häufigste Fehler mit dem unklarsten Bild: **HTTP 401 auf alles**, weil das
Vinted-Session-Cookie abgelaufen ist. Es hilft nichts, den CSRF zu erneuern.

```js
// SW-Konsole
chrome.storage.local.get(['sessions', 'liveTokens']).then(console.log);
```

Ist `sessions` leer oder alt: einen `vinted.de`-Tab öffnen, einloggen, Seite neu laden. Der
webRequest-Snooper greift die Tokens von Vinteds eigenen Calls ab — es braucht also eine
Seite, die welche macht.

## 3. Das Log lesen

```js
// SW-Konsole — die letzten 30 Zeilen
chrome.storage.local.get('log').then(({ log }) => console.log(log.slice(-30).join('\n')));

// Nur ein Ereignis herausfiltern
chrome.storage.local.get('log').then(({ log }) =>
  console.log(log.filter(l => l.includes('studio_recrop')).join('\n')));

// Leeren
chrome.storage.local.set({ log: [] });
```

Bequemer: im Popup unter **Log & Fehler kopieren** — das liefert Version, URL, Status und
Log in einem Rutsch, in der Form, in der ein Fehlerbericht brauchbar ist.

Ereignisse, nach denen sich das Suchen lohnt:

| Ereignis | sagt |
|---|---|
| `publish_start` / `publish_done` | Anfang und Ende eines Veröffentlichens, mit Version |
| `publish_blocked` | der Draft war nicht vollständig — mit der Blocker-Liste |
| `publish_conflict` | Vinteds Gegenprobe widerspricht |
| `publish_failed` | der Create wurde abgelehnt, mit den betroffenen Feldern |
| `category_attributes` | was diese Kategorie verlangt und was davon offen ist |
| `studio_recrop` / `_skipped` / `_failed` | der zweite Zuschnitt-Durchgang, samt Box und Grund |
| `book_language` | welche Sprache gewählt wurde und woher sie kommt |
| `create_rejected_probe`, `fetchItem_shape` | Vinteds echte Feldformen bei einem 422 (ADR-0004) |

## 4. Einzelne Module aus der Konsole aufrufen

Der SW exportiert nichts global; dynamischer Import auf den Extension-Pfad funktioniert:

```js
// SW-Konsole
const { parseUrl, buildNewItemPayload } = await import(chrome.runtime.getURL('lib/item.js'));
const { draftView } = await import(chrome.runtime.getURL('lib/draft-view.js'));
const { chooseFrame, objectBox } = await import(chrome.runtime.getURL('lib/crop.js'));

parseUrl('https://www.vinted.de/items/1234567890-hoodie');
```

Reine Module lassen sich so direkt befragen — sie brauchen weder Netz noch Storage. Für
alles mit Effekt gibt es den Port (ADR-0008); den ruft man besser im Test auf als hier.

## 5. Der wichtigste Härtetest: „Create darf scheitern, Original muss leben"

**Nicht mehr per Monkey-Patch.** Genau dafür gibt es die Naht — der Test steht schon da und
läuft in Millisekunden:

```bash
node --test tests/relist.test.js
```

Jeder Fehlerpfad prüft `port.called('deleteItem') === false`. Willst du einen neuen
Fehlerfall absichern, schreib ihn dort hinein statt ihn im Browser nachzustellen:

```js
const port = makeFakePort({ createItem: () => { throw new ApiError(500, 'boom'); } });
await assert.rejects(() => relist(URL, port));
assert.equal(port.called('deleteItem'), false);
```

Dasselbe fürs Auto-Listing in `tests/draft.test.js` mit `port.called('uploadPhoto')`.

## 6. Requests wirklich sehen

Im **Vinted-Tab** (F12), Network-Tab, Filter `api/v2`:

- `GET /api/v2/item_upload/items/<id>` — Artikeldaten
- `POST /api/v2/photos` — je Foto eines
- `POST /api/v2/item_upload/items` — der Create
- `DELETE /api/v2/items/<id>` — das Löschen

Kommt der Create mit **422** oder **400** zurück: Rechtsklick → **Copy as cURL** → mit dem
Body eines von Hand erstellten Artikels vergleichen. Genau dort sitzen abweichende
Feldnamen. Danach `buildItemUploadPayload` bzw. `buildNewItemPayload` in `lib/item.js`
anpassen — und den Befund in `docs/TECHNISCHE_DOKUMENTATION.md` §6 notieren, denn das ist
die einzige Stelle, an der Vinteds API dokumentiert ist.

## 7. Content-Script debuggen

Es läuft im Tab, nicht im SW:

1. Im Vinted-Tab DevTools öffnen (F12).
2. **Sources** → links **Content scripts** → `content/content.js`.
3. Die Tab-Konsole zeigt auch die `[vinted-relist]`-Zeilen, die der Proxy schreibt.

Erscheint kein Relist-Button, liegt es fast immer an `card-policy.js`: es entscheidet, welche
Karten einen bekommen (eigene, aktive, nicht verkauft). Direkt befragen:

```js
// Tab-Konsole
VintedCardPolicy.relistability(document.querySelector('[data-testid^="product-item-id-"]'));
```

## 8. Studio debuggen

Das Studio ist ein eigener Tab mit eigenen DevTools (F12 dort). Es ist die einzige
Oberfläche, die selbst rechnet — Zuschnitt und KI-Call —, also lohnt sich der Blick dorthin.

- **Der Zuschnitt sitzt falsch?** Neben jedem Foto steht ein Link „was die KI sieht". Damit
  lässt sich beantworten, ob das Modell das Etikett überhaupt sehen konnte. Im Log stehen
  zusätzlich `mode` (`crop`/`pad`), die benutzte Box und die Maße.
- **Ein Feld blockiert und du verstehst nicht warum?** Der Grund steht als Notiz am Feld,
  nicht nur in „Noch offen".
- **Der KI-Call schlägt fehl?** `studio_analyse_failed` im Log trägt Meldung und Status. Der
  Key ist entweder entsperrt oder nicht — das Popup sagt es unter Einstellungen. Er wird
  nie geloggt.

Der Zustand des Studios (`state`) ist **modul-privat** und aus der Konsole nicht lesbar —
das Studio ist ein ES-Modul. Wer wirklich hineinsehen muss: **Sources** → `studio/studio.js`
→ Breakpoint in `render()` setzen → im Scope-Panel liegt `state`. Für den Alltag reicht das
Log, das dieselben Entscheidungen mitschreibt:

```js
// Studio-Konsole
chrome.storage.local.get('log').then(({ log }) =>
  console.log(log.filter(l => l.includes('studio_')).slice(-20).join('\n')));
```

## 9. Reload-Reihenfolge

Nach jeder Code-Änderung:

1. `chrome://extensions` → ⟳ bei der Erweiterung.
2. SW-DevTools-Fenster schließen und neu öffnen (der alte SW ist tot).
3. Vinted-Tab neu laden, damit das Content-Script die neue Fassung bekommt.
4. Studio-Tab neu laden.
5. Versionsnummer in der Oberfläche prüfen.

## 10. Häufige Fehlerbilder

| Symptom | Wahrscheinliche Ursache | Fix |
|---|---|---|
| Überall HTTP 401 | Vinted-Session-Cookie abgelaufen | Vinted-Tab öffnen, neu einloggen, Seite neu laden |
| „Öffne kurz Vinted und versuche es erneut" | Kein CSRF/anon-id im Storage | dito — der Snooper braucht eine Seite, die Calls macht |
| `400 size: Wähle ein Größe` | Ein Größenwort ohne Vinted-ID ist durchgerutscht | Sollte nicht mehr vorkommen (`NEEDS_ID`). Wenn doch: Log-Zeile `publish_failed` mit ins Ticket |
| `400 language_book` / `400 isbn` | Kategorie verlangt ein Attribut, das nicht belegt ist | Sprache in `lib/book.js` nachtragen (von Hand messen!), ISBN im Feld korrigieren |
| Preisvorschlag bleibt leer | Vinted braucht Kategorie, Marke **und** Zustand — und hat für manche Familien gar keine Vergleichsverkäufe | Der Hinweis unter dem Feld sagt, welcher Fall es ist |
| Zuschnitt zu weit / `too_small` im Log | Die Box wäre zu klein für ein brauchbares Inseratsbild (< 432 px Rahmenbreite) | Schwelle ist `maxUpscale` in `lib/crop.js`. **Nicht raten** — mit einem echten Foto messen |
| HTTP 429 | Rate limit | Warten; `withRetry` fängt bis zu drei Versuche ab |
| Popup zeigt nach dem Klick nichts | SW war inaktiv, der Erstkontakt ist langsam | Nochmal klicken; die SW-Konsole zeigt, ob er aufgewacht ist |
| Erweiterung ist plötzlich 18 MB groß | `npx c8` hat `coverage/tmp` liegen lassen | `rm -rf coverage`, und `npm run coverage` benutzen |
| Erweiterung ist langsam auf ein paar MB gewachsen | `.git` hat nie gepackt — lose Objekte speichern jede Dateiversion ganz | `git gc` (verliert nichts), `du -sh .` zur Kontrolle |
