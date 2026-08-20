/**
 * Rekorder für Schritt 0b — schneidet Vinteds eigene API-Aufrufe mit, während du das
 * Formular bedienst, und gibt sie als Antwort-FORMEN aus statt als Rohdaten.
 *
 * Das ist der Unterschied, auf den es hier ankommt: für die API-Referenz brauchen wir
 * Pfade, Eingabeparameter und Feldnamen — nicht deine Artikel, nicht deine Tokens. Der
 * Rekorder ersetzt Werte durch ihren Typ, kürzt lange Zeichenketten und schwärzt alles,
 * was nach Zugangsdaten aussieht. Was am Ende herauskommt, kannst du gefahrlos teilen.
 *
 * ── SO GEHT ES ──────────────────────────────────────────────────────────────────────
 *
 *  1. https://www.vinted.de/items/new öffnen, eingeloggt.
 *  2. DevTools öffnen (F12) → Reiter „Console".
 *     Beim ersten Mal verlangt Chrome, dass du „allow pasting" tippst und Enter drückst.
 *  3. Diese Datei komplett hineinkopieren, Enter. Es meldet sich mit „Rekorder läuft".
 *  4. Jetzt das Formular bedienen — in dieser Reihenfolge, dann sind alle drei
 *     Prüfpunkte abgedeckt:
 *       a) EIN Foto hochladen und warten, bis die Seite reagiert
 *          → zeigt, ob Vinted selbst etwas erkennt (Kategorie? Marke?)
 *       b) Kategorie wählen, Marke wählen, Zustand wählen
 *          → zeigt den Kategoriebaum- und den Markensuche-Endpoint
 *       c) ins Preisfeld klicken bzw. warten, bis eine Preisspanne erscheint
 *          → zeigt den Preisvorschlags-Endpoint und seine Eingabeparameter
 *  5. `__vintedSpike.dump()` in die Console tippen, Enter.
 *     Das Ergebnis liegt in der Zwischenablage.
 *  6. NICHT veröffentlichen — den Entwurf verwerfen. Der Spike ist ein Lesevorgang.
 *
 * `__vintedSpike.stop()` hängt den Rekorder wieder aus, `.clear()` leert ihn.
 * Ein Reload der Seite entfernt ihn ohnehin restlos — es wird nichts installiert.
 */
(() => {
  const MAX_STRING = 60;
  const MAX_ARRAY_SHAPE = 1;
  const MAX_DEPTH = 6;

  /** Alles, was nach Zugangsdaten oder Person aussieht, wird nie ausgegeben. */
  const SECRET_KEY = /csrf|token|anon|cookie|auth|session|password|udt|uid|email|phone|iban|address|login/i;
  /** Werte, die auch ohne verdächtigen Schlüssel wie ein Geheimnis aussehen. */
  const SECRET_VALUE = /^[A-Za-z0-9+/=_-]{40,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;

  const calls = [];
  let active = true;

  /**
   * Die Form eines Wertes statt des Wertes: Typen, Feldnamen, Array-Längen. Kurze
   * Zahlen und Aufzählungswerte bleiben stehen — genau die brauchen wir, um `catalog_id`
   * von `catalog_ids` zu unterscheiden.
   */
  function shape(value, key = '', depth = 0) {
    if (value === null) return 'null';
    if (depth > MAX_DEPTH) return '…';
    if (SECRET_KEY.test(key)) return '«geschwärzt»';

    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      return [`array(${value.length})`, ...value.slice(0, MAX_ARRAY_SHAPE).map(v => shape(v, key, depth + 1))];
    }
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = shape(v, k, depth + 1);
      return out;
    }
    if (typeof value === 'string') {
      if (SECRET_VALUE.test(value)) return '«geschwärzt»';
      return value.length > MAX_STRING ? `string(${value.length})` : value;
    }
    return value; // Zahlen und Booleans sind hier die eigentliche Information
  }

  function parse(body) {
    if (body == null) return null;
    if (typeof body === 'string') {
      try { return shape(JSON.parse(body)); } catch { return `string(${body.length})`; }
    }
    if (body instanceof FormData) {
      const out = {};
      for (const [k, v] of body.entries()) out[k] = v instanceof Blob ? `blob(${v.size})` : shape(v, k);
      return out;
    }
    return `«${body.constructor?.name || typeof body}»`;
  }

  /** Query-Parameter interessieren uns als Namen und Typen, nicht als Werte. */
  function splitUrl(raw) {
    try {
      const url = new URL(raw, location.origin);
      const query = {};
      for (const [k, v] of url.searchParams) query[k] = shape(v, k);
      return { path: url.pathname, query: Object.keys(query).length ? query : undefined };
    } catch {
      return { path: String(raw) };
    }
  }

  const interesting = url => /\/api\//.test(String(url));

  function record(entry) {
    calls.push({ n: calls.length + 1, t: new Date().toISOString().slice(11, 19), ...entry });
    console.log(`  ⏺ ${entry.method} ${entry.path} → ${entry.status}`);
  }

  // --- fetch ---------------------------------------------------------------------------
  const originalFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url;
    const response = await originalFetch.apply(this, arguments);
    if (!active || !interesting(url)) return response;

    const entry = { method: (init.method || input?.method || 'GET').toUpperCase(), ...splitUrl(url), status: response.status };
    entry.request = parse(init.body);
    try {
      entry.response = shape(await response.clone().json());
    } catch {
      entry.response = '«kein JSON»';
    }
    record(entry);
    return response;
  };

  // --- XMLHttpRequest (die SPA benutzt beides) -----------------------------------------
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__spike = { method: String(method).toUpperCase(), url };
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__spike;
    if (active && meta && interesting(meta.url)) {
      this.addEventListener('load', () => {
        const entry = { method: meta.method, ...splitUrl(meta.url), status: this.status, request: parse(body) };
        try { entry.response = shape(JSON.parse(this.responseText)); } catch { entry.response = '«kein JSON»'; }
        record(entry);
      });
    }
    return send.call(this, body);
  };

  window.__vintedSpike = {
    calls,
    clear: () => { calls.length = 0; console.log('Rekorder geleert.'); },
    stop: () => { active = false; window.fetch = originalFetch; console.log('Rekorder gestoppt.'); },
    dump() {
      const text = JSON.stringify({ host: location.host, captured: calls.length, calls }, null, 2);
      try { copy(text); console.log(`${calls.length} Aufrufe in der Zwischenablage.`); } catch { console.log(text); }
      return `${calls.length} Aufrufe`;
    }
  };

  console.log('%cRekorder läuft.', 'color:#09b1ba;font-weight:bold');
  console.log('Formular bedienen, danach: __vintedSpike.dump()');
})();
