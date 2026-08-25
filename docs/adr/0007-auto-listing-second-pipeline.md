# ADR-0007 — Auto-Listing als zweite Pipeline in derselben Extension

**Status:** accepted · **Date:** 2026-08-13

## Context

Neue Artikel sollen aus Fotos entstehen: Erkennung, Zuschnitt, Titel, Beschreibung, Preis,
Create. Der Relist-Pfad löst davon nur das Posten — und auch das nur, weil er die IDs des
Originalartikels abschreibt. Für einen neuen Artikel gibt es kein Original.

Drei Alternativen lagen auf dem Tisch:

1. Ein eigenständiger Agent außerhalb des Browsers (Node + CDP).
2. Eine separate lokale Anwendung nur für Stufe 1 (Zuschnitt, Erkennung, Text) — die
   kommt gänzlich ohne Vinted-Calls aus.
3. Eine zweite Pipeline in dieser Extension.

Erschwerend: Das Feature braucht eine KI-Anbindung mit API-Key, während
`docs/TECHNISCHE_DOKUMENTATION.md` bisher „kein Backend, keine gespeicherten
Zugangsdaten" als Prinzip führt.

## Decision

**Zweite Pipeline (`lib/draft.js`) in dieser Extension**, gegen einen eigenen Port, unter
Wiederverwendung von Auth, `page-api.js` und den reinen Helfern aus `item.js`.

Die tragenden Teilentscheidungen:

- **Eigener Payload-Builder.** `buildNewItemPayload()` neben `buildItemUploadPayload()`,
  gemeinsame reine Helfer. Kein synthetisches `src`-Objekt durch die bestehende Funktion.
- **Schreib-Sperre statt Pipeline-Sperre.** Die Invariante aus `CONTEXT.md` heißt künftig
  „ein schreibender Vorgang", nicht „eine Pipeline". Vorbereitung läuft frei, ab dem
  ersten Foto-Upload wird dasselbe Lock genommen, das `relist()` hält.
- **Studio-Page als vierter Laufzeitkontext.** Zuschnitt (DOM-Canvas) und KI-Calls laufen
  dort. Der Service Worker bleibt Router; er sieht `draft/lookup` (lesend) und
  `draft/publish` (schreibend, ein Aufruf mit einer Antwort).
- **Entscheidungen in `lib/`, nicht im Studio.** `lib/draft-view.js` liefert das
  Render-Modell; die UI rendert nur. Dasselbe Muster wie `gates.js`.
- **Trockenlauf als Default.** `draftCreateEnabled: false`; bis zur fertigen Payload läuft
  alles, der POST unterbleibt.
- **API-Key im Extension-Storage, verschlüsselt.** `lib/secret.js` mit WebCrypto:
  `PBKDF2` + `AES-GCM`, Passphrase einmal pro Browser-Sitzung, Klartext-Key nur in
  `chrome.storage.session`.

Das Prinzip wird dabei präzisiert, nicht gebrochen: *„keine gespeicherten
**Vinted**-Zugangsdaten, kein Backend im Vinted-Pfad."* Ein eigener Drittanbieter-Key ist
eine andere Kategorie als die Vinted-Session: Sein Verlust kostet Geld, nicht den Account.

## Consequences

- Ein Vinted-Tab bleibt Voraussetzung — ADR-0001 gilt unverändert.
- Die Extension wird ein Werkzeugkasten und bekommt mit Stufe 3 einen neutralen Namen.
- Neue Abhängigkeit zur Anthropic-API. `api.anthropic.com` kommt in `host_permissions`;
  der Call braucht `anthropic-dangerous-direct-browser-access: true`.
- Die Studio-UI wächst in der Zone, die das Projekt bewusst nicht unit-testet. Das ist der
  Preis der Verortungsentscheidung; `draft-view.js` hält die Entscheidungslogik heraus.
- Die Verschlüsselung schützt gegen späteren Zugriff auf Profilverzeichnis oder Backup,
  **nicht** gegen jemanden am entsperrten Rechner. Der wirksamere Schutz ist ein eigener
  Key mit hartem Ausgabelimit im Anthropic-Konto: Verschlüsselung senkt die
  Wahrscheinlichkeit, das Limit begrenzt den Schaden.

## Addendum 2026-08-25 (v0.116.0) — gebaut, mit zwei Abweichungen

Die Pipeline läuft, an echten Artikeln. Zwei Punkte oben stimmen so nicht mehr:

- **`draft/lookup` gibt es nicht.** Es steht oben als lesende Nachricht an den Worker; die
  Taxonomie-Aufrufe laufen stattdessen **direkt aus dem Studio-Tab** — lesend darf das
  (Addendum zu ADR-0001). Über die Naht geht nur `draft/publish`, plus `draft/gates` und
  `draft/confirmed`. Das ist die schärfere Fassung derselben Absicht: der Worker bekommt
  einen Aufruf und gibt eine Antwort, statt minutenlang zu leben.
- **„Ein Vinted-Tab bleibt Voraussetzung"** gilt nur fürs *Veröffentlichen*. Einen Draft
  vorzubereiten — Fotos, Zuschnitt, Erkennung, IDs auflösen, Preis — braucht keinen offenen
  Vinted-Tab. Es braucht eine gültige Sitzung; ist die abgelaufen, sagen die Lookups das
  ausdrücklich (`SESSION_EXPIRED`), statt 401 zu verschlucken.

Dazu die Namensfrage: die Extension heißt weiterhin „Vinted Relist". Der neutrale Name war
an Stufe 3 gekoppelt, und das Stufenmodell hat sich als Oberfläche nicht bewährt (siehe
`docs/KONZEPT_AUTO_LISTING.md` §4.1). Umbenennen bleibt offen.

Die Naht selbst hat inzwischen ihre eigene ADR: **ADR-0008**.

## Do not re-suggest

**„Ein Node-Agent postet das."** Mit einem echten Browser über CDP technisch möglich — der
Origin-Einwand aus ADR-0001 greift dort nicht. Er müsste aber Auth-Beschaffung,
Multipart-Transport und Fehlerklassifikation neu bauen, wäre gegenüber Anti-Bot-Heuristiken
deutlich auffälliger und brächte eine zweite Toolchain. Neu zu bewerten nur, wenn der
Content-Script-Seam dauerhaft bricht.

**„Stufe 1 als separates kleines Tool."** Verlockend, weil sie keinen einzigen Vinted-Call
macht. Aber Stufe 3 braucht `title.js` und `crop.js` ohnehin hier, und zwei Kopien
derselben Logik sind genau das Muster, das ADR-0006 und `gates.js` beseitigt haben.

**„Den Key mit einem im Code liegenden Schlüssel verschlüsseln."** Wer an den Storage
kommt, kommt auch an den Code. Kostet einen Angreifer eine Minute und erzeugt ein falsches
Sicherheitsgefühl — schlechter als bewusster Klartext.

**„Die KI die Kategorie-/Größen-IDs direkt ausgeben lassen."** Sie liefert Strings, die
`resolve.js` deterministisch gegen Vinteds Kandidatenlisten mappt. Eine geratene ID im
öffentlichen Inserat ist bei Kleidung ein Gewährleistungsfall — siehe ADR-0005 und die
Begründung in `conditionId()`.
