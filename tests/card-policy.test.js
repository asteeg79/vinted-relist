import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../content/card-policy.js'; // classic script: loaded for its globalThis side effect

/**
 * Which wardrobe cards get a destructive Relist button.
 *
 * This inference — "Vinted only renders a bump button on your own unsold items" — decides
 * who we offer to delete listings for, and until now lived in a comment and was verified
 * nowhere. The policy takes a duck-typed card, so no jsdom is needed.
 */
const { relistability, SKIP } = globalThis.VintedCardPolicy;

/** A minimal stand-in for a rendered card element. */
function card({ testid = 'product-item-id-9178024265', text = 'Lego City Rennwagen 5,00 €', boost = true } = {}) {
  return {
    getAttribute: name => (name === 'data-testid' ? testid : null),
    textContent: text,
    querySelector: selector => (boost && selector.includes('bump-button') ? { parentElement: {} } : null)
  };
}

// ---------- the happy case ----------

test('a card that is ours, unsold and identifiable may be relisted', () => {
  assert.deepEqual(relistability(card()), { ok: true, itemId: '9178024265' });
});

test('the push-up testid is accepted as well as bump', () => {
  const pushUpOnly = {
    ...card({ boost: false }),
    querySelector: selector => (selector.includes('push-up-button') ? {} : null)
  };
  assert.equal(relistability(pushUpOnly).ok, true);
});

// ---------- ownership / sold ----------

test('no boost button means not ours (or already sold) — skipped', () => {
  const verdict = relistability(card({ boost: false }));
  assert.deepEqual(verdict, { ok: false, reason: SKIP.NOT_OWNED });
});

test('sold or reserved text is refused even when a boost button is present', () => {
  // The independent second gate: if Vinted ever rendered the boost button more widely,
  // this still keeps sold items out.
  for (const word of ['Verkauft', 'SOLD', 'reserviert', 'Reserved']) {
    const verdict = relistability(card({ text: `Lego City ${word}`, boost: true }));
    assert.deepEqual(verdict, { ok: false, reason: SKIP.SOLD }, `"${word}" must be refused`);
  }
});

test('sold detection is case-insensitive and matches within longer text', () => {
  assert.equal(relistability(card({ text: 'Diese Hose wurde VERKAUFT am 1.1.' })).reason, SKIP.SOLD);
});

// ---------- card identification ----------

test('child elements of a card are not treated as cards', () => {
  // The `product-item-id-` prefix also matches `…--image` / `…--description`.
  for (const testid of ['product-item-id-123--image', 'product-item-id-123--description']) {
    assert.deepEqual(relistability(card({ testid })), { ok: false, reason: SKIP.NOT_A_CARD });
  }
});

test('an unrelated element is not a card', () => {
  assert.equal(relistability(card({ testid: 'some-other-thing' })).reason, SKIP.NOT_A_CARD);
  assert.equal(relistability(card({ testid: '' })).reason, SKIP.NOT_A_CARD);
});

test('a card with a non-numeric id is refused rather than guessed at', () => {
  // It looks like a root card, so the refusal comes from the id gate, not the shape gate.
  assert.deepEqual(
    relistability(card({ testid: 'product-item-id-abc' })),
    { ok: false, reason: SKIP.NO_ID }
  );
});

test('the item id is extracted without the slug', () => {
  assert.equal(relistability(card({ testid: 'product-item-id-42' })).itemId, '42');
});

// ---------- robustness ----------

test('a malformed or absent card never throws', () => {
  for (const input of [null, undefined, {}, { getAttribute: () => null }]) {
    const verdict = relistability(input);
    assert.equal(verdict.ok, false, 'must refuse, not crash');
  }
});

test('a card with no textContent is still evaluated', () => {
  const bare = { ...card(), textContent: null };
  assert.equal(relistability(bare).ok, true);
});

test('every refusal carries a reason a caller can report', () => {
  const refusals = [
    relistability(card({ testid: 'x' })),
    relistability(card({ text: 'verkauft' })),
    relistability(card({ boost: false }))
  ];
  for (const verdict of refusals) {
    assert.equal(verdict.ok, false);
    assert.ok(Object.values(SKIP).includes(verdict.reason), `unknown reason: ${verdict.reason}`);
  }
});
