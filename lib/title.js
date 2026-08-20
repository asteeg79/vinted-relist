/**
 * Titelbau — deterministic, slot by slot.
 *
 * The requirement "the title always carries Marke, Art, Größe, Farbe" cannot be
 * guaranteed by a prompt. The model fills slots; THIS builds the title. That way the
 * requirement hangs on a test instead of on a model's mood.
 *
 * The fixed schema is a Profil (KONZEPT §7.3) and applies to clothing, not universally —
 * a book has no size, a bag has no size worth printing. Each profile names its slots in
 * render order, the slots that may never be dropped, and the order in which the optional
 * ones give way when the title gets too long.
 *
 * Pure: no chrome.*, no DOM, no I/O.
 */

/**
 * Two limits, not one.
 *  - SOFT_MAX is the display optimum: search results cut the title off around here.
 *    Measured in characters, because that is what a list truncates.
 *  - HARD_MAX is Vinted's own limit, which rejects the create call when exceeded.
 *    Measured in BYTES: whether Vinted counts characters or bytes is unverified
 *    (KONZEPT §12.6), and a rejected create is worse than a slightly short title.
 */
export const SOFT_MAX = 60;
export const HARD_MAX = 100;

export const PROFILES = {
  clothing:    { slots: ['brand', 'type', 'size', 'color'],     required: ['brand', 'type', 'size'], dropOrder: ['color'] },
  shoes:       { slots: ['brand', 'type', 'size', 'color'],     required: ['brand', 'type', 'size'], dropOrder: ['color'] },
  accessories: { slots: ['brand', 'type', 'color', 'material'], required: ['brand', 'type'],         dropOrder: ['material', 'color'] },
  media:       { slots: ['work', 'author', 'format'],           required: ['work'],                  dropOrder: ['format'] },
  generic:     { slots: ['brand', 'type', 'model', 'color'],    required: ['type'],                  dropOrder: ['color', 'model'] }
};

const byteLength = text => new TextEncoder().encode(text).length;
const present = value => typeof value === 'string' ? value.trim() : (value == null ? '' : String(value).trim());

/**
 * The profile for a category group as the model reports it (`category_group` in the
 * analysis schema). Anything unknown falls back to `generic` — a wrong-but-sane title
 * beats a thrown error while the model's five-way classification is still unproven.
 */
export function profileFor(categoryGroup) {
  return PROFILES[String(categoryGroup ?? '').toLowerCase()] || PROFILES.generic;
}

/**
 * Build the title from filled slots.
 *
 * Shortening walks `dropOrder` until the result is within the soft limit; required slots
 * are never dropped, so a title CAN legitimately end up longer than SOFT_MAX. Only the
 * hard limit is absolute.
 *
 * Never pads a short title. The observed 40–60 characters of good listings are a
 * consequence of naming things properly, not a target — filler words ("TOP",
 * "hochwertig") only push search terms out.
 */
export function buildTitle(fields = {}, profile = PROFILES.clothing, opts = {}) {
  const soft = opts.softMax ?? SOFT_MAX;
  const hard = opts.hardMax ?? HARD_MAX;

  const render = dropped => profile.slots
    .filter(slot => !dropped.includes(slot) || profile.required.includes(slot))
    .map(slot => present(fields[slot]))
    .filter(Boolean)
    .join(' ');

  const dropped = [];
  let title = render(dropped);
  for (const slot of profile.dropOrder) {
    if (title.length <= soft) break;
    dropped.push(slot);
    title = render(dropped);
  }

  // Emergency brake: if even the required slots run past the API limit, cut at a word
  // boundary. A rejected create is worse than a short title.
  return byteLength(title) > hard ? truncateAtWord(title, hard) : title;
}

/** Which required slots are still empty. A non-empty result blocks the draft. */
export function missingRequired(fields = {}, profile = PROFILES.clothing) {
  return profile.required.filter(slot => !present(fields[slot]));
}

/**
 * Cut to at most `maxBytes`, preferring whole words — a fragment ("Kapuzenpullo") reads
 * like a bug in a public listing. If not even the first word fits, cut inside it, by code
 * point, so no character is torn in half.
 */
function truncateAtWord(text, maxBytes) {
  let out = '';
  for (const word of text.split(' ')) {
    const next = out ? `${out} ${word}` : word;
    if (byteLength(next) > maxBytes) break;
    out = next;
  }
  if (out) return out;

  let cut = '';
  for (const char of text) {
    if (byteLength(cut + char) > maxBytes) break;
    cut += char;
  }
  return cut;
}
