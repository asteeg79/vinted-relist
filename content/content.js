/**
 * Content script — runs inside every Vinted page. Two responsibilities:
 *
 *   1. API PROXY: execute fetches the service worker asks for (`api/call` messages) so
 *      they carry the page's real same-origin Origin + cookies (Vinted rejects calls
 *      from chrome-extension:// origins). This is the page-side half of lib/page-api.js.
 *
 *   2. WARDROBE ENHANCER: inject a "Relist" button onto each of the user's own active
 *      item cards, and drive the relist from there with an on-page toast + dialogs.
 *
 * It does NOT gather auth tokens — the service worker does that (webRequest snooper for
 * the CSRF token, chrome.cookies for the rest), and does it better, since chrome.cookies
 * can read the HttpOnly session cookies this context cannot see. See PART 1.
 *
 * The whole file is guarded by a window flag so re-injection (the SW auto-injects into
 * tabs that predate the extension) doesn't register duplicate listeners.
 */
if (window.__vintedRelistLoaded) {
  // Already injected in this page — do nothing.
} else {
  window.__vintedRelistLoaded = true;

// ====================================================================================
// PART 1 — API proxy
// ====================================================================================
//
// This part used to also scrape auth tokens from the page and report them to the SW.
// It was removed in 0.37.0: it looked for the CSRF token in a <meta name="csrf-token">
// tag and in XSRF-TOKEN / csrf_token cookies, none of which Vinted uses — it is a Next.js
// app whose token lives in an inline script, and whose session cookies are HttpOnly. So
// the reporter only ever sent csrf: null, which saveSession then merged over a good
// token. Both fields it tried to supply are already covered, and covered better, by the
// SW's webRequest snooper (live CSRF) and chrome.cookies (which can read HttpOnly).
(function () {
  /**
   * API proxy: run a fetch on behalf of the SW and return the raw response parts.
   * The message→fetch translation lives in content/page-call.js so both halves of the
   * seam are described in one place and the encoding can be tested without a live upload.
   */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'api/call') return; // not ours — let other listeners handle it

    (async () => {
      try {
        const { init, warnings } = VintedPageCall.buildInit(msg);
        const r = await fetch(msg.path, init);
        const body = await r.text();
        sendResponse({
          ok: true, status: r.status, contentType: r.headers.get('content-type'), body,
          warnings // e.g. a blob that decoded to the wrong size — the SW decides what to do
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async sendResponse → keep the channel open
  });
})();

// ====================================================================================
// PART 2 — Wardrobe Enhancer (the on-page "Relist" buttons + toast)
// ====================================================================================
(function () {
  const REFRESH_KEY = 'progress';
  let scheduled = false;  // debounce flag for the MutationObserver
  // Whether THIS tab's button is mid-run — purely local UI state, used to keep the toast
  // showing our own progress. The "only one relist at a time" rule itself is enforced in
  // lib/relist.js, which rejects a concurrent run with BusyError.
  let thisTabRunning = false;

  /**
   * Every candidate card on the page. Which of them may actually be relisted is decided by
   * content/card-policy.js, not here — see that file for the ownership inference.
   */
  function findItemCards() {
    return [...document.querySelectorAll(VintedCardPolicy.CARD_SELECTOR)];
  }

  /** Build the teal "Relist" button (refresh icon + label), styled by inject.css. */
  function makeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vr-bump-btn';
    btn.innerHTML = '<svg class="vr-bump-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg><span>Relist</span>';
    btn.title = 'Artikel löschen und neu einstellen';
    return btn;
  }

  /** Add the button to one card if the policy allows it. Idempotent per card. */
  function injectIntoCard(card) {
    if (card.querySelector('.vr-bump-btn')) return; // already injected

    const verdict = VintedCardPolicy.relistability(card);
    if (!verdict.ok) return; // not ours, sold, or unidentifiable — skip silently

    const btn = makeButton();
    btn.addEventListener('click', (e) => {
      // Stop the click from bubbling to the card's own "open item" navigation.
      e.preventDefault();
      e.stopPropagation();
      handleBumpClick(verdict.itemId, btn, card);
    });
    // Sit next to the native boost button when possible, else append to the card.
    const boost = card.querySelector(VintedCardPolicy.BOOST_SELECTOR);
    if (boost?.parentElement) boost.parentElement.appendChild(btn);
    else card.appendChild(btn);
  }

  function enhance() {
    findItemCards().forEach(injectIntoCard);
  }

  /** Coalesce the many mutations a React render emits into a single enhance() per 150ms. */
  function queueEnhance() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; enhance(); }, 150);
  }

  // ----------- Gate dialog (Promise<boolean>) -----------
  /**
   * Render one gate from lib/gates.js as a blocking confirm dialog and resolve
   * true/false — an in-page replacement for window.confirm() (which closes extension
   * popups).
   *
   * A content script declared in the manifest can't use ESM imports, so the gates arrive
   * over the `relist/preflight` message rather than from an import. Either way this
   * function only renders: which gates exist, their order and their copy are decided in
   * lib/gates.js, shared with the popup.
   */
  function showDialog({ title, text, lines, note }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'vr-backdrop';
      const dialog = document.createElement('div');
      dialog.className = 'vr-dialog';

      const h = document.createElement('h3');
      h.textContent = title;
      dialog.appendChild(h);
      if (text) {
        const p = document.createElement('p');
        p.textContent = text;
        dialog.appendChild(p);
      }
      if (lines && lines.length) {
        const ul = document.createElement('ul');
        for (const ln of lines) {
          const li = document.createElement('li');
          li.textContent = ln;
          ul.appendChild(li);
        }
        dialog.appendChild(ul);
      }
      if (note) {
        const p = document.createElement('p');
        p.textContent = note;
        dialog.appendChild(p);
      }

      const actions = document.createElement('div');
      actions.className = 'vr-dialog-actions';
      const cancel = document.createElement('button');
      cancel.className = 'vr-btn vr-btn-cancel';
      cancel.textContent = 'Abbrechen';
      const ok = document.createElement('button');
      ok.className = 'vr-btn vr-btn-confirm';
      ok.textContent = 'Fortfahren';
      actions.appendChild(cancel);
      actions.appendChild(ok);
      dialog.appendChild(actions);

      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);

      const done = (result) => { backdrop.remove(); resolve(result); };
      cancel.onclick = () => done(false);
      ok.onclick = () => done(true);
      // Click outside the dialog = cancel.
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(false); });
    });
  }

  // ----------- Toast (bottom-right progress + result) -----------
  /** Create the toast container once (with a close button) and return it. */
  function ensureToast() {
    let toast = document.getElementById('vrToast');
    if (toast) return toast;
    toast = document.createElement('div');
    toast.id = 'vrToast';
    toast.className = 'vr-toast';
    toast.innerHTML = `
      <div class="vr-toast-header">
        <span class="vr-toast-title">Vinted Relist</span>
        <button class="vr-toast-close" aria-label="Schließen">×</button>
      </div>
      <div class="vr-toast-body"></div>
    `;
    toast.querySelector('.vr-toast-close').onclick = () => hideToast();
    document.body.appendChild(toast);
    return toast;
  }

  /**
   * Render/update the progress bar inside the toast, plus the phase list.
   *
   * `steps` kommt fertig aus dem Fortschritts-Datensatz (`lib/steps.js` entscheidet, der
   * Adapter wählt die Liste). Hier wird nichts abgeleitet: dieses Skript ist als
   * Manifest-Content-Script geladen und darf keine Module importieren — es wäre also
   * ausgerechnet die Stelle, an der eine zweite Kopie der Regel niemand prüft.
   */
  function setToastProgress(pct, step, steps) {
    const toast = ensureToast();
    toast.classList.remove('hide');
    const body = toast.querySelector('.vr-toast-body');
    if (!body.querySelector('.vr-toast-track')) {
      // First call: lay out the bar markup.
      body.innerHTML = `
        <div class="vr-toast-row">
          <span class="vr-toast-step"></span>
          <span class="vr-toast-pct">0%</span>
        </div>
        <div class="vr-toast-track"><div class="vr-toast-fill"></div></div>
        <ul class="vr-toast-steps"></ul>
      `;
    }
    body.querySelector('.vr-toast-step').textContent = step || '…';
    body.querySelector('.vr-toast-pct').textContent = `${Math.round(pct)}%`;
    body.querySelector('.vr-toast-fill').style.width = `${pct}%`;

    const list = body.querySelector('.vr-toast-steps');
    list.replaceChildren(...(steps || []).map(s => {
      const li = document.createElement('li');
      li.className = 'vr-toast-phase is-' + s.state;
      // Das Zeichen sagt die Lage auch dann, wenn jemand die Farben nicht unterscheidet.
      const mark = document.createElement('span');
      mark.className = 'vr-toast-mark';
      mark.textContent = s.state === 'done' ? '✓' : (s.state === 'current' ? '▸' : '·');
      const text = document.createElement('span');
      text.textContent = s.label;
      li.append(mark, text);
      return li;
    }));
  }

  /** Swap the toast to a final result message (optionally with a link to the new item). */
  function setToastResult({ kind, text, newUrl, newId, autoHideMs = 6000 }) {
    const toast = ensureToast();
    toast.classList.remove('hide');
    const body = toast.querySelector('.vr-toast-body');
    const linkHtml = newUrl && newId
      ? `<a class="vr-toast-link" href="${newUrl}" target="_blank">Zum neuen Artikel #${newId}</a>`
      : '';
    body.innerHTML = `<div class="vr-toast-result ${kind}">${text}${linkHtml ? '<br>' + linkHtml : ''}</div>`;
    if (autoHideMs > 0) setTimeout(hideToast, autoHideMs);
  }

  function hideToast() {
    const toast = document.getElementById('vrToast');
    if (!toast) return;
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 350); // allow the fade-out transition
  }

  // ----------- Live progress wiring -----------
  // The SW publishes progress to storage; mirror it into the toast — but only while THIS
  // tab is the one running a relist, so a run started elsewhere can't hijack
  // this tab's toast.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[REFRESH_KEY]) return;
    const p = changes[REFRESH_KEY].newValue;
    if (!p || typeof p.pct !== 'number') return;
    if (!thisTabRunning) return;
    setToastProgress(p.pct, p.step, p.steps);
  });

  // ----------- Click handler: the full on-page relist flow -----------
  async function handleBumpClick(itemId, btn, card) {
    if (thisTabRunning) {
      setToastResult({ kind: 'warning', text: 'Bereits ein Bump läuft.', autoHideMs: 2500 });
      return;
    }
    thisTabRunning = true;
    btn.disabled = true;
    btn.classList.add('is-loading');
    const url = `${location.origin}/items/${itemId}`;

    try {
      // 1. Preflight → interest, recent-relist counts, and the ordered gates the user
      //    must clear (non-destructive). Every decision was made in lib/gates.js; this
      //    script only shows them, so the toast and the popup can't drift apart.
      setToastProgress(2, 'Artikel prüfen…', []);
      const pre = await chrome.runtime.sendMessage({ type: 'relist/preflight', url });
      if (!pre?.ok) throw new Error(pre?.error || 'Preflight fehlgeschlagen');
      // Ab hier steht die Liste — noch ohne einen erledigten Schritt, aber vollständig.
      // Wer auf „Relist" drückt, sieht sofort, was ihn erwartet, statt eine Zahl.
      const steps = pre.steps || [];

      // 2. Walk the gates in order; any refusal aborts.
      for (const gate of pre.gates || []) {
        const ok = await showDialog(gate);
        if (!ok) { setToastResult({ kind: 'warning', text: 'Abgebrochen.' }); return; }
        // Accepting the first-run gate is remembered so it isn't asked again.
        if (gate.remember) await chrome.runtime.sendMessage({ type: 'relist/confirmed' });
      }

      // 3. Run the destructive pipeline; the SW streams progress into the toast meanwhile.
      setToastProgress(2, 'Anmeldedaten prüfen…', steps);
      const res = await chrome.runtime.sendMessage({ type: 'relist/run', url });

      setToastResult(res?.message || { kind: 'error', text: 'Fehler: unbekannt', autoHideMs: 10000 });
      // Grey out the now-deleted original until the SPA refreshes its list.
      if (res?.message?.kind === 'ok') card.setAttribute('data-vr-relisted', '1');
    } catch (e) {
      setToastResult({ kind: 'error', text: 'Fehler: ' + e.message, autoHideMs: 10000 });
    } finally {
      thisTabRunning = false;
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  }

  // ----------- Initialise -----------
  function init() {
    enhance(); // first pass over whatever's already rendered
    if (document.body) {
      // Re-enhance as the SPA renders/paginates more cards.
      new MutationObserver(() => queueEnhance()).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
}
