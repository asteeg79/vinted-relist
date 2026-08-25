# ADR-0005 — Auto-default colour, never condition or size

**Status:** accepted · **Date:** 2026-08-12

## Context

Vinted enforces per-category required fields at create time, and those requirements change.
An old listing can lack a field its category now demands, which fails the relist.

For colour the pipeline already auto-recovers: on a `color` validation error with no source
colour it retries once with a neutral default ("Bunt"). The obvious generalisation is to do
the same for the other fields that get rejected — condition and size.

## Decision

No. Colour is auto-defaulted; condition and size never are.

A neutral colour is cosmetically wrong at worst. A guessed **condition** tells a buyer the
item is in a state the seller never claimed, and a guessed **size** is simply wrong
information on a public listing. Both misdescribe goods to a third party who is deciding
whether to buy.

When condition or size cannot be read, the pipeline fails before creating anything and the
original is left untouched.

## Consequences

- `conditionId()` and `sizeId()` return null rather than a fallback, and their tests assert
  this explicitly.
- A Vinted field rename breaks relisting outright instead of quietly producing wrong
  listings. That is the intended failure mode.

## Addendum 2026-08-25 (v0.116.0) — the rule outgrew its title

The auto-listing pipeline (ADR-0007) invents fields where the relist path only copies them,
so the same question arrived four more times. Each was answered the same way, and the rule
is better stated as: **a value that misdescribes goods to a buyer is never guessed.**

| Field | Why it may not be guessed |
|---|---|
| **Category** (`catalog_id`) | Everything else hangs off it — the size set, the brand list, the price range. A wrong one files the article where nobody looks for it. `buildNewItemPayload` throws without it rather than sending `null`. |
| **Book language** (`language_book`) | Vinted publishes no list at all; every id in `lib/book.js` comes from a listing created by hand. A wrong language is invisible until a buyer unwraps an English book. |
| **ISBN** | Cleaned, not guessed: the hyphens printed on every book spine are removed, because that is the same number written differently. What does not clean into a valid form blocks the field. |
| **Price** | Vinted's own midpoint, or a decision by the user. Never an estimate — see KONZEPT §7.4. |

The mechanism is `NEEDS_ID` in `lib/draft-view.js`: a filled-looking field with no Vinted id
behind it is `missing`, not `needs_confirmation`. That distinction is the whole point —
**confirming a name cannot conjure an id**, so no amount of clicking "Passt" may release it.
It was added after exactly that happened: a category the recognition guessed sat at
`needs_confirmation`, the user pressed "Passt", and the failure surfaced after the write
lock was taken and three photos were uploaded.

The counterpart rule: **every block hangs on a field the user can change.** A blocker line
with no field behind it is not a check, it is a wall — the book language was one for two
versions before it got its own field.

Colour remains the one auto-defaulted field, unchanged.

## Do not re-suggest

"Default the condition to 'Gut' / the size to one-size so the relist can proceed." Failing
is correct here. The user can fix the source listing; a buyer cannot un-read a wrong
condition.

"Fall back to a plausible category / the marketplace's language when nothing resolves."
Same answer, same reason. `null` and a stop, before the first photo is uploaded.
