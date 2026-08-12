# ADR-0002 — Create the clone before deleting the original, never the reverse

**Status:** accepted · **Date:** 2026-05 (recorded 2026-08-12)

## Context

Deleting first would be simpler and slightly faster: one less thing to undo, no window
where two listings exist, and the ordering matches how a user does it by hand.

But this pipeline destroys user data that cannot be recovered. A deleted Vinted listing is
gone — with its photos, its description, and its accumulated interest.

## Decision

The pipeline always creates the clone first and only deletes the original after the clone
is confirmed. Three gates stand in front of the delete:

1. The create must succeed.
2. The clone must be re-fetchable and have photos (`verifyAfterCreate`).
3. The logged-in user must own the original.

Any failure returns a **partial** outcome and keeps the original.

## Consequences

- A failed run can leave two live listings. That is the intended trade: a duplicate is an
  annoyance, a deletion is unrecoverable.
- The delete is the last call in the pipeline, right after the photo-upload burst, which
  makes it the most likely to be rate-limited — it needs its retry path to work (see
  ADR-0003's sibling concern in `lib/page-api.js`).
- Every failure-path test in `tests/relist.test.js` asserts `countOf('deleteItem') === 0`.
  Those assertions are the executable form of this decision.

## Do not re-suggest

Reordering for simplicity, or removing the verify step because "create already returned an
id". Vinted's backend needs seconds to make a new listing queryable; the verify step exists
because a create that returns 200 is not proof the listing is real.
