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

## Do not re-suggest

"Default the condition to 'Gut' / the size to one-size so the relist can proceed." Failing
is correct here. The user can fix the source listing; a buyer cannot un-read a wrong
condition.
