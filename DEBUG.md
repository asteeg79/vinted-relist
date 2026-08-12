# Debug-Cheat-Sheet

Quick-Recipes für die Service-Worker-DevTools-Konsole. Vorgehen für alle:

1. `chrome://extensions` → bei "Vinted Relist" auf **Service Worker** klicken (Link unter "Untersuchen"). Falls "Service worker (inactive)" steht, einmal das Extension-Icon klicken — dann wacht er auf.
2. Du landest in einem dedizierten DevTools-Fenster mit Tabs **Console**, **Network**, **Sources**.
3. In die Console einfügen, Enter.

## 0. Statisches Setup vor jedem Live-Test

```bash
npm run check     # validate + unit tests in einem Rutsch
```

Wenn etwas rot ist, *nicht* in Chrome laden — erst dort fixen.

## 1. Aktuelle Session anzeigen

```js
chrome.storage.local.get('sessions').then(console.log);
```

Erwartete Form:
```js
{ sessions: { 'www.vinted.de': { csrf: 'abc…', ts: 1715… } } }
```
Wenn `sessions` leer ist → auf vinted.de einen Tab öffnen + einloggen, Seite neu laden, dann erneut prüfen. Das Content-Script schickt das Token erst nach `report()`.

## 2. CSRF-Token manuell setzen (z.B. um aus DevTools heraus zu testen)

```js
const csrf = document.querySelector('meta[name=csrf-token]').content;  // im vinted-Tab ausführen!
// Dann zurück im SW:
chrome.storage.local.set({ sessions: { 'www.vinted.de': { csrf: 'PASTE_HIER', ts: Date.now() } } });
```

## 3. Log live mitlesen

```js
chrome.storage.local.get('log').then(({ log }) => console.log(log.slice(-20).join('\n')));
```

Oder Log leeren:
```js
chrome.storage.local.set({ log: [] });
```

## 4. Einzelne Pipeline-Schritte isoliert aufrufen

Der SW exportiert keine globalen Funktionen — du musst die Module re-importieren. Trick: dynamic import vom SW-Pfad funktioniert in der Service-Worker-Console:

```js
const api = await import(chrome.runtime.getURL('lib/vinted-api.js'));
const { parseUrl, buildPayloadFromSource } = await import(chrome.runtime.getURL('lib/transform.js'));

// (a) Aktuellen User holen — testet Auth + Cookies
await api.getCurrentUser('www.vinted.de');

// (b) Eigenes Item holen
const csrf = (await chrome.storage.local.get('sessions')).sessions['www.vinted.de'].csrf;
const item = await api.fetchItem('www.vinted.de', csrf, '1234567890');
console.table({ title: item.title, photos: item.photos.length, owner: item.user_id });

// (c) Payload generieren OHNE zu posten — zum Feldnamen-Vergleich mit Live-Request
console.log(JSON.stringify(buildPayloadFromSource(item, ['dummy-uuid']), null, 2));
```

## 5. Failure-Injection: "Create darf scheitern, Original muss leben"

Das ist der wichtigste Härtetest. Vor dem Klicken auf "Löschen & neu einstellen":

```js
// im SW-Console — monkey-patch createItem auf einen Fehler
const api = await import(chrome.runtime.getURL('lib/vinted-api.js'));
const real = api.createItem;
api.createItem = async () => { throw new Error('SIMULATED CREATE FAIL'); };
// Test machen → Popup zeigt "Fehler". Dann in vinted.de prüfen: Original-Artikel muss noch da sein.
// Zurücksetzen:
api.createItem = real;
```

Hinweis: ES-Module-Exports sind in modernen Chrome live-mutierbar, aber der SW muss dafür dasselbe Modul-Objekt benutzen. Falls das Monkey-Patching nicht greift, alternativer Trick: in `service-worker.js` temporär `throw new Error('test')` direkt nach `buildPayloadFromSource` einfügen, SW reloaden.

## 6. Network-Tab nutzen

Der **Network** -Tab des SW-DevTools-Fensters zeigt **nur die fetch()-Calls aus dem SW** — Vinted-Calls aus dem Tab selbst landen hier nicht. Filtere nach `vinted` und du siehst:
- `GET /api/v2/users/current`
- `GET /api/v2/items/<id>`
- `POST /api/v2/photos` (mehrfach)
- `POST /api/v2/items`
- `DELETE /api/v2/items/<id>`

Wichtig: Wenn `POST /api/v2/items` mit 422 zurückkommt → Request rechtsklick → **Copy as cURL** → mit dem Body eines manuell erstellten Artikels vergleichen. Genau dort sitzen die abweichenden Feldnamen (`package_size_id` vs. `shipment_package_size_id` etc.). Dann in [lib/transform.js:18](lib/transform.js) `buildPayloadFromSource` anpassen.

## 7. Content-Script Debugging

Das Content-Script läuft im Tab, nicht im SW. Um es zu inspizieren:
1. Im vinted-Tab DevTools öffnen (F12).
2. **Sources** → links Tab "Content scripts" → `content/content.js`.
3. `console.log('csrf:', document.querySelector('meta[name=csrf-token]')?.content)` in die Tab-Console.

## 8. Schnell-Reload-Workflow

Nach jeder Code-Änderung:
1. `chrome://extensions` → bei der Extension den ⟳-Button klicken.
2. SW-DevTools-Fenster schließen + neu öffnen (der alte SW ist tot).
3. Vinted-Tab einmal reloaden, damit das Content-Script die neue Version lädt.

## 9. Häufige Fehlerbilder

| Symptom | Wahrscheinliche Ursache | Fix |
|---|---|---|
| `Open https://www.vinted.de in a tab and log in first` | Kein CSRF in `chrome.storage.local.sessions` | Vinted-Tab öffnen + einloggen + Seite reloaden |
| `AuthError: Not logged in (401)` | Session-Cookie abgelaufen | Vinted neu einloggen |
| `HTTP 422` bei `createItem` | Feldname/Wert passt nicht zur aktuellen API | Mit DevTools-Capture vergleichen, `buildPayloadFromSource` patchen |
| `HTTP 429` | Rate limit | Warten, `withRetry` fängt es bis zu 3 Versuchen ab |
| `Photo fetch failed: 403` | CDN verlangt manchmal Referer | In `fetchAsBlob` `headers: { Referer: 'https://www.vinted.de' }` ergänzen |
| Popup zeigt nichts nach Klick | SW war inaktiv, Erstkontakt ist langsam | Nochmal klicken; Logs in Console prüfen |
