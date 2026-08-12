# ADR-0004 — Read Vinted fields through alias helpers, and log the shape when they move

**Status:** accepted · **Date:** 2026-08-12 (v0.38.0–0.39.0)

## Context

Vinted renames and reshapes response fields without notice. On 2026-07-11 the item
response carried `status_id` and `size_id`; on 2026-08-12 both were gone. Because
`JSON.stringify` drops `undefined`, the condition silently vanished from the create body
and every relist failed with `condition: Wähle ein Zustand`.

Diagnosing it required comparing two log lines a month apart and noticing an *absent* key.

## Decision

1. Fields known to move are read through alias helpers (`conditionId`, `sizeId`,
   `pickPhotoUrl`, `extractInterest`), which try each known shape in turn and return null
   rather than undefined.
2. When a create is REJECTED, the pipeline logs `create_rejected_probe`: the rejected field
   names plus the values of every candidate source field. It fires only on a rejection —
   an item that legitimately lacks a size (a comic) is not a problem and must not log a
   scary line. `fetchItem_shape` carries the resolved values on every run.
4. `item_attributes` is replayed verbatim into the create payload. Vinted keeps
   per-category fields there (condition, book language, …) and which ones a category
   demands changes; dropping the bag silently loses data the user had set.
3. The user-facing error distinguishes "we could not read this" from "you left this blank",
   because the advice differs completely.

## Consequences

- A rename is diagnosable from a copied log, without inspecting a live API response.
- Alias chains grow over time. That is acceptable; they are pure and cheap to test.

## Do not re-suggest

Reading `src.status_id` (or any other volatile field) directly because "that's what the API
returns". It is what the API returned on the day it was written.

## Confirmed shapes (2026-08-12)

From a live `create_rejected_probe`:

```json
{"size_id":null,"package_size_id":1,
 "item_attributes":[{"code":"condition","ids":[2]}],
 "color1":null,"status":"Sehr gut"}
```

- `status` is a **string label**, not an id — deliberately not mapped (see ADR-0005).
- The condition id lives in `item_attributes` as `{code, ids:[…]}`.
- `size_id` may be present-but-null, or absent entirely, depending on the item.
