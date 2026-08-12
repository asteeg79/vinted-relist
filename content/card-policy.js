/**
 * Which wardrobe cards may get a Relist button, and why not when they may not.
 *
 * This is the most volatile knowledge in the extension — Vinted's `data-testid`
 * conventions — and it decides which items get a *destructive* button. It used to be four
 * functions welded to `document` inside content.js, verified nowhere. Extracted so tests
 * can drive it with hand-built card objects.
 *
 * THE OWNERSHIP INFERENCE: Vinted renders a bump/push-up button only on the logged-in
 * user's own unsold items, so its presence stands in for both "mine" and "not sold". That
 * saves needing the HttpOnly `v_uid` cookie, but it means a Vinted change to that testid
 * changes who we offer to delete for. If they rename it, the button quietly disappears
 * (harmless). If they ever render it more widely, we would offer to delete items that
 * aren't the user's — which is why the sold/reserved text check is kept as a second,
 * independent gate rather than folded into the first.
 *
 * A card only has to look like { getAttribute, querySelector, textContent } — no real DOM
 * is required, which is what makes this testable without jsdom.
 *
 * WHY NO IMPORTS: see content/page-call.js — manifest-declared content scripts are classic
 * scripts. Having no import/export also lets the tests load this file as an ES module for
 * its globalThis side effect.
 */
(function (root) {
  /** Root item cards. The prefix also matches child elements (`…--image`), hence the `--` exclusion. */
  const CARD_SELECTOR = '[data-testid^="product-item-id-"]';
  const BOOST_SELECTOR = 'button[data-testid="bump-button"], button[data-testid="push-up-button"]';
  const SOLD_PATTERN = /verkauft|sold|reserviert|reserved/;

  /** Reasons a card is skipped. Returned rather than logged so callers can explain themselves. */
  const SKIP = {
    NOT_A_CARD: 'not-a-root-card',
    SOLD: 'sold-or-reserved',
    NOT_OWNED: 'no-boost-button',   // not the user's, or already sold
    NO_ID: 'no-item-id'
  };

  function isRootCard(card) {
    const testid = card?.getAttribute?.('data-testid') || '';
    return testid.startsWith('product-item-id-') && !testid.includes('--');
  }

  function itemIdOf(card) {
    const match = /^product-item-id-(\d+)/.exec(card?.getAttribute?.('data-testid') || '');
    return match ? match[1] : null;
  }

  /**
   * May this card be relisted? Returns { ok: true, itemId } or { ok: false, reason }.
   * Every gate is checked in a fixed order so a skip reason is unambiguous.
   */
  function relistability(card) {
    if (!isRootCard(card)) return { ok: false, reason: SKIP.NOT_A_CARD };

    // Belt-and-braces: anything visibly marked sold/reserved is skipped even if a boost
    // button is somehow present.
    if (SOLD_PATTERN.test((card.textContent || '').toLowerCase())) {
      return { ok: false, reason: SKIP.SOLD };
    }
    if (!card.querySelector?.(BOOST_SELECTOR)) {
      return { ok: false, reason: SKIP.NOT_OWNED };
    }
    const itemId = itemIdOf(card);
    if (!itemId) return { ok: false, reason: SKIP.NO_ID };

    return { ok: true, itemId };
  }

  root.VintedCardPolicy = { relistability, CARD_SELECTOR, BOOST_SELECTOR, SKIP };
})(typeof globalThis === 'undefined' ? self : globalThis);
