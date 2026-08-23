/**
 * Objektbox, Rahmen und Padding — the geometry behind "the object is never cut off".
 *
 * PURE: works on a grayscale array, never touches a canvas or the DOM. The canvas
 * adapter (studio/canvas.js) downsizes a photo, hands the pixels here, and then applies
 * whatever this module decided. That split is deliberate: the decision that must never be
 * wrong is the one that is unit-tested, and the untested zone only draws.
 *
 * The rule (KONZEPT §5.2): don't crop to 4:5 and hope. First find where the object is,
 * then remove only demonstrably empty margin. If no 4:5 Rahmen fits around the Objektbox,
 * pad instead of cutting. Every doubtful case ends in padding — too much background is a
 * cosmetic flaw, a missing sleeve is a misdescribed article.
 *
 * Thresholds are settings, not truths: they depend on the surface and the light the user
 * photographs on, and are meant to be calibrated against real photos (KONZEPT §12).
 */

export const DEFAULTS = {
  safetyMarginPct: 0.04, // grown per edge — fringes, cords, straps and shadows sit just
                         // outside what a threshold search calls "object"
  bgTolerance: 24,       // FLOOR for |luminance − background|; the real tolerance is derived
                         // from how much the border actually varies (see below)
  edgeEnergy: 12,        // FLOOR for the mean gradient a row/column may carry and still
                         // count as empty; likewise derived from the border
  bgNoise: 48,           // above this much border variation there is no background to speak of
  toleranceFactor: 3,    // colour tolerance = factor × the border's own deviation
  energyFactor: 2,       // energy tolerance = factor × the border's own energy
  noisePixelPct: 0.02,   // share of deviating pixels tolerated per row/column (dust, JPEG artefacts)
  maxBoxFillPct: 0.95,   // a box filling more than this means the peel found nothing
  aspect: 4 / 5,         // width / height of the Rahmen
  maxW: 1080,
  maxH: 1350,
  // --- the model's own box (see boxFromModel) ---------------------------------------
  //
  // DIE UNTERGRENZE WAR EINMAL 5 % DER BILDFLÄCHE — und hat damit ausgerechnet die
  // Aufnahmen verworfen, für die der Zuschnitt am meisten bringt: der Prompt verlangt bei
  // einem Etikettfoto die Box um das ETIKETT, und ein eingenähtes Nackenetikett ist im
  // Handyfoto routinemäßig ein bis drei Prozent. Das Log meldete `too_small`, was nach
  // einem Missverständnis des Modells klingt, und war doch nur unsere Schwelle.
  //
  // Zwei getrennte Fragen, jetzt auch getrennt beantwortet:
  //   minModelBoxPct  ist das überhaupt eine Box? (entartete Splitter, Missverständnisse)
  //   maxUpscale      wie unscharf darf das Inseratsbild werden? Das ist der echte Schaden
  //                   an einem kleinen Ausschnitt — nicht seine Größe an sich.
  // Der Zuschlag für eine Box, die MIT DEM AUGE gezeichnet wurde. Die Heuristik misst am
  // Pixel und kommt mit 4 % aus; das Modell nennt Zahlen zu einem Bild, das es angesehen
  // hat, und liegt dabei um ein paar Prozent daneben. Beobachtet am 2026-08-23: im
  // Titelbild eines eingestellten Inserats lief der rechte Ärmel in die Bildkante — der
  // Rahmen kann die Box nicht anschneiden, also enthielt die Box den Ärmel nicht.
  //
  // RELATIV ZUR BOX, nicht zum Bild. Der Fehler des Modells wächst mit dem Gegenstand, den
  // es umrandet, nicht mit dem Foto. Und 10 % des Bildes waren in der Messung fatal: eine
  // Box über 80 % der Bildbreite wurde damit so breit wie das Foto, der 4:5-Rahmen so hoch
  // wie möglich — und dann ließ er sich nicht mehr zentrieren, weil er nirgendwo mehr
  // hinkonnte.
  modelMarginPct: 0.06,
  minModelBoxPct: 0.005, // 0,5 % der Fläche: darunter ist es kein Ausschnitt mehr
  maxUpscale: 2.5,       // der 4:5-Rahmen darf höchstens so weit hochskaliert werden
  modelBoxInsetPct: 0.02 // below this much inset there is nothing to gain from recropping
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isWhole = x => Math.abs(x - Math.round(x)) < 1e-9;

function median(values) {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The Objektbox: where the photographed article is, plus the safety margin.
 *
 * `pixels` is one luminance byte per pixel (w*h), as produced by toGrayscale(). Rows and
 * columns are peeled from the outside in while they are BOTH close to the border's median
 * colour AND carry almost no edge energy — a garment that happens to match the background
 * in average brightness still shows up as texture, and a shadow gradient does not.
 *
 * Returns { x, y, w, h, certain, touchesEdge }:
 *  - `certain: false` when the background is too busy to be a reference, when nothing
 *    could be peeled, or when the raw box fills more than `maxBoxFillPct` of the image.
 *    Callers must pad in that case — see chooseFrame.
 *  - `touchesEdge: true` when the object already ran out of the frame when the photo was
 *    taken (KONZEPT §5.6). Neither cropping nor padding repairs that; the studio says so.
 */
export function objectBox(pixels, w, h, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  // `stats` exists so a failure is diagnosable from the log instead of by guesswork —
  // the thresholds above need calibrating against real photos (KONZEPT §12.2), and
  // "nothing peeled" and "the object really fills the frame" look identical without them.
  const whole = (stats = {}) => ({ x: 0, y: 0, w, h, certain: false, touchesEdge: false, stats });
  if (!w || !h || !pixels || pixels.length < w * h) return whole({ reason: 'no_pixels' });

  // --- background reference: median of the border ring ------------------------------
  const border = [];
  for (let x = 0; x < w; x++) { border.push(pixels[x]); border.push(pixels[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { border.push(pixels[y * w]); border.push(pixels[y * w + w - 1]); }
  const bg = median(border);
  // Median absolute deviation. A border that varies more than `bgNoise` is not a
  // background at all (a patterned rug, other objects in shot) — the answer is
  // "uncertain", not a guess.
  const spread = median(border.map(v => Math.abs(v - bg)));
  if (spread > o.bgNoise) return whole({ reason: 'busy_border', bg, spread });

  const rowEnergy = (y) => {
    let energy = 0;
    const row = y * w;
    for (let x = 1; x < w; x++) energy += Math.abs(pixels[row + x] - pixels[row + x - 1]);
    return energy / Math.max(1, w - 1);
  };
  const colEnergy = (x) => {
    let energy = 0;
    for (let y = 1; y < h; y++) energy += Math.abs(pixels[y * w + x] - pixels[(y - 1) * w + x]);
    return energy / Math.max(1, h - 1);
  };

  // THE TOLERANCES ARE RELATIVE, NOT ABSOLUTE. A garment is rarely photographed on a
  // studio backdrop: a wooden floor, a carpet or a bed sheet carries real texture, and
  // daylight puts a gradient across the frame. Measured against a fixed threshold every
  // row of such a background looks like an object, nothing peels, and the result is the
  // "object touches the edge" warning on a photo with plenty of margin. So the border
  // sets its own bar, and the constants are only the floor for a genuinely clean surface.
  const colourTol = Math.max(o.bgTolerance, o.toleranceFactor * spread);
  const borderEnergy = median([rowEnergy(0), rowEnergy(h - 1), colEnergy(0), colEnergy(w - 1)]);
  const energyTol = Math.max(o.edgeEnergy, o.energyFactor * borderEnergy);

  const rowAllowance = Math.max(1, Math.round(w * o.noisePixelPct));
  const colAllowance = Math.max(1, Math.round(h * o.noisePixelPct));

  const isEmptyRow = (y) => {
    let deviating = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (Math.abs(pixels[row + x] - bg) > colourTol && ++deviating > rowAllowance) return false;
    }
    return rowEnergy(y) <= energyTol;
  };

  const isEmptyCol = (x) => {
    let deviating = 0;
    for (let y = 0; y < h; y++) {
      if (Math.abs(pixels[y * w + x] - bg) > colourTol && ++deviating > colAllowance) return false;
    }
    return colEnergy(x) <= energyTol;
  };

  const measured = {
    bg: Math.round(bg),
    spread: Math.round(spread),
    colourTol: Math.round(colourTol),
    borderEnergy: Math.round(borderEnergy),
    energyTol: Math.round(energyTol)
  };

  // --- peel from the outside in -----------------------------------------------------
  let top = 0;
  while (top < h && isEmptyRow(top)) top++;
  // Nothing but background — a photo of the floor.
  if (top === h) return whole({ reason: 'no_object', ...measured });

  let bottom = h - 1;
  while (bottom > top && isEmptyRow(bottom)) bottom--;
  let left = 0;
  while (left < w && isEmptyCol(left)) left++;
  let right = w - 1;
  while (right > left && isEmptyCol(right)) right--;

  const raw = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  // How many rows/columns each side gave up. All four at zero is the signature of
  // thresholds that are too strict for this surface — nothing was recognised as margin.
  const stats = {
    ...measured,
    peel: { top, bottom: h - 1 - bottom, left, right: w - 1 - right },
    fillPct: Math.round((raw.w * raw.h) / (w * h) * 100)
  };
  // Measured on the RAW box: a box that already fills the image means the peel found no
  // margin at all, which is the definition of an unreliable detection.
  const certain = (raw.w * raw.h) <= o.maxBoxFillPct * w * h;
  // ONLY a confident detection may claim this. "Nothing could be trimmed on this side"
  // and "the object runs out of the frame" are different statements, and the peel can
  // only ever observe the first: a shadow under the garment, a fold in the sheet or the
  // edge of the surface stop it exactly as reliably as the article itself. Deriving the
  // second from an uncertain box is how this warning came to fire on every photo — the
  // model's own `cropped_off` verdict on the finished image is the signal that can carry it.
  const touchesEdge = certain
    && (left === 0 || top === 0 || right === w - 1 || bottom === h - 1);

  // --- safety margin, clamped to the image ------------------------------------------
  const mx = Math.round(w * o.safetyMarginPct);
  const my = Math.round(h * o.safetyMarginPct);
  const x = clamp(raw.x - mx, 0, w);
  const y = clamp(raw.y - my, 0, h);
  return {
    x,
    y,
    w: clamp(raw.x + raw.w + mx, 0, w) - x,
    h: clamp(raw.y + raw.h + my, 0, h) - y,
    certain,
    touchesEdge,
    stats
  };
}

/**
 * Pick the Rahmen — or decide to pad.
 *
 * Returns either
 *   { mode: 'crop', x, y, w, h, touchesEdge, reason: null }        cut background away
 *   { mode: 'pad',  x, y, w, h, offsetX, offsetY, touchesEdge, reason }  fill what is missing
 *
 * `crop` is returned ONLY when a 4:5 frame containing the whole Objektbox fits inside the
 * image AND sits centred on it. Everything else pads.
 *
 * DER ARTIKEL BLEIBT IN DER MITTE — auch wenn er dafür nicht ins Bild passt.
 *
 * Bis 0.104.0 wurde der Rahmen an die Bildkante geschoben, sobald er zentriert nicht mehr
 * hineinpasste. Gemessen an einem 3024×4032-Foto mit flach liegendem Pullover: in der
 * Bildmitte 317 px über und 318 px unter der Box — tadellos. Lag der Artikel im unteren
 * Drittel, waren es 1355 oben und 41 unten, und im Inserat stand der Pullover ganz unten
 * am Rand mit einem Feld Fußboden darüber.
 *
 * Das Schieben war die falsche Antwort auf „passt nicht": es rettet den Bildinhalt und
 * opfert die Bildkomposition. Ein 4:5-Rahmen um einen breit liegenden Artikel ist nun
 * einmal höher als das Foto hergibt — was fehlt, wird jetzt gefüllt, in der Farbe des
 * Hintergrunds, den das Foto ohnehin zeigt.
 *
 * `offsetX/offsetY` bleiben dabei genau das, was sie immer waren: wo der Originalpixel 0
 * auf der Leinwand liegt. Für einen Rahmen, der über das Bild hinausragt, ist das negativ
 * — und `compose` zeichnet dann eben ein Stück außerhalb, was die Leinwand von selbst
 * abschneidet. Deshalb kostet diese Änderung in `canvas.js` keine Zeile.
 */
export function chooseFrame(box, imgW, imgH, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const touchesEdge = !!box?.touchesEdge;

  /** Das ganze Bild mittig auf der kleinsten 4:5-Leinwand — für einen Fund, dem wir nicht trauen. */
  const padWhole = (reason) => {
    let w = Math.ceil(Math.max(imgW, imgH * o.aspect));
    for (let i = 0; i < 8 && !isWhole(w / o.aspect); i++) w++;
    const h = Math.max(imgH, Math.round(w / o.aspect));
    const offsetX = Math.round((w - imgW) / 2);
    const offsetY = Math.round((h - imgH) / 2);
    return { mode: 'pad', x: -offsetX, y: -offsetY, w, h, offsetX, offsetY, touchesEdge, reason };
  };

  if (!box || !box.certain) return padWhole('uncertain');

  // Smallest 4:5 frame that holds the box. Snapped up to a width whose height is a whole
  // pixel, so the output lands on exactly 1080×1350 rather than one pixel off.
  let frameW = Math.ceil(Math.max(box.w, box.h * o.aspect));
  for (let i = 0; i < 8 && !isWhole(frameW / o.aspect); i++) frameW++;
  const frameH = Math.round(frameW / o.aspect);

  // Mittig auf der Box — aber nicht an einer Kante, an der die Box das Bild berührt.
  //
  // EINE BOX AM BILDRAND IST NICHT DER ARTIKEL, sondern sein sichtbarer Teil. Läuft er
  // schon in der Aufnahme aus dem Bild (`peel: {top: 0, left: 0}`, `touchesEdge: true`),
  // liegt sein wahrer Mittelpunkt außerhalb des Fotos — auf die abgeschnittene Box zu
  // zentrieren schiebt den Rahmen dorthin, wo gar nichts mehr ist, und füllt die Lücke mit
  // Farbe. Genau das war am 2026-08-23 im Titelbild zu sehen.
  //
  // Also seitenweise: gefüllt wird nur dort, wo der Artikel VOLLSTÄNDIG im Bild liegt und
  // die Mitte deshalb etwas bedeutet. Wo er hinausläuft, wird geklemmt — dort gibt es
  // nichts zu zeigen und nichts zu ergänzen.
  //
  // Ein Nachzug „halte die Box im Rahmen" stand hier einmal und ist ersatzlos weg: die
  // zentrierte Position IST die Mitte des erlaubten Intervalls
  // `[boxStart + boxLen - frameLen, boxStart]`, der Clamp also die Identität — über 4,9
  // Millionen erzeugten Fällen kein einziges Mal wirksam. Die Zusage hängt ohnehin nicht
  // an ihm, sondern an der Prüfung unten, die einen verletzenden Rahmen verwirft.
  const place = (boxStart, boxLen, frameLen, imgLen) => {
    const centred = Math.round(boxStart + boxLen / 2 - frameLen / 2);
    const atStart = boxStart <= 0;
    const atEnd = boxStart + boxLen >= imgLen;
    if (atStart && atEnd) return Math.round((imgLen - frameLen) / 2); // die Achse ist voll
    if (atStart) return Math.max(centred, 0);
    if (atEnd) return Math.min(centred, imgLen - frameLen);
    return centred;
  };
  const x = place(box.x, box.w, frameW, imgW);
  const y = place(box.y, box.h, frameH, imgH);

  // The invariant, asserted rather than assumed: a frame that would cut the object is
  // never returned, whatever the arithmetic above did. A non-finite number counts as a
  // failure too — NaN passes every comparison below and would reach the canvas as a
  // silently broken draw.
  const sane = [x, y, frameW, frameH].every(Number.isFinite);
  if (!sane || x > box.x || y > box.y || x + frameW < box.x + box.w || y + frameH < box.y + box.h) {
    return padWhole('no_fitting_frame');
  }

  const inside = x >= 0 && y >= 0 && x + frameW <= imgW && y + frameH <= imgH;
  if (inside) return { mode: 'crop', x, y, w: frameW, h: frameH, touchesEdge, reason: null };

  return {
    mode: 'pad',
    x,
    y,
    w: frameW,
    h: frameH,
    offsetX: -x,
    offsetY: -y,
    touchesEdge,
    reason: 'padded_to_centre'
  };
}

/**
 * Turn the model's own box for the article into an Objektbox in ORIGINAL image coordinates.
 *
 * WHY THIS EXISTS. `objectBox` finds the article by peeling away background, and that is
 * exactly as good as the assumption that everything non-background IS the article. The
 * photographer's shoes at the bottom edge are not background, so they were kept — and no
 * threshold can fix that, because the shoes are a perfectly good object. Only something
 * that knows what a hoodie looks like can say "that part down there is not the article".
 *
 * THE COORDINATE TRAP. The model was shown the ALREADY CROPPED photo, so its box is
 * normalised to that composition, not to the original. Mapping back is the whole job here —
 * und seit jeder Rahmen sein `x`/`y` trägt, ist es dieselbe Rechnung für beide Modi: der
 * Rahmen begann an `(frame.x, frame.y)` im Original. Bei einem gefüllten Rahmen ist das
 * negativ, und genau das stimmt: eine Box an seiner linken Kante sitzt links vom ersten
 * Originalpixel, also in der Füllung. Die frühere Fallunterscheidung über `offsetX` war
 * dasselbe Ergebnis auf zwei Wegen — und der Vorzeichenfehler darin hat einmal jedes
 * gepolsterte Foto seitlich verschoben.
 *
 * A BOX IS A PROPOSAL, NOT AN INSTRUCTION. Everything implausible is refused and the
 * heuristic's result stands: outside 0..1, inverted, non-finite, or so small that the
 * model clearly boxed a detail instead of the article. Refusing costs a bit of background
 * in the listing; accepting a wrong box cuts the sleeve off (KONZEPT §5.2).
 *
 * Returns a box shaped exactly like `objectBox`'s, so `chooseFrame` consumes it unchanged
 * — or null, which means "keep what you had".
 */
export function boxFromModel(normalised, frame, imgW, imgH, opts = {}) {
  return modelBoxVerdict(normalised, frame, imgW, imgH, opts).box;
}

/**
 * The same decision, with the reason attached — `{ box, reason }`.
 *
 * `reason` is 'ok', or why not: 'malformed', 'outside', 'too_small', 'in_padding', or
 * 'full_frame'. `too_small` heißt seit 0.95.0 „der Ausschnitt müsste zu stark
 * hochgerechnet werden", nicht mehr „kleiner als 5 % der Fläche". The last one is not a complaint: "the article fills the picture" is a
 * perfectly good answer that simply leaves the first pass in place. Separating it from a
 * real refusal is what keeps the log honest — a line saying "refused" for the normal case
 * trains the reader to ignore the line that matters.
 */
export function modelBoxVerdict(normalised, frame, imgW, imgH, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = normalised;
  const no = reason => ({ box: null, reason });
  if (!n || !frame) return no('malformed');

  const nums = [n.x, n.y, n.w, n.h];
  if (!nums.every(v => typeof v === 'number' && Number.isFinite(v))) return no('malformed');
  if (n.w <= 0 || n.h <= 0) return no('malformed');
  // Half a percent of slack: a model that says 1.002 means "to the edge", not "outside".
  if (n.x < -0.005 || n.y < -0.005 || n.x + n.w > 1.005 || n.y + n.h > 1.005) return no('outside');
  if (n.w * n.h < o.minModelBoxPct) return no('too_small');

  // Nothing worth redrawing for: the box already is the frame, give or take a hair.
  const inset = Math.max(n.x, n.y, 1 - (n.x + n.w), 1 - (n.y + n.h));
  if (inset < o.modelBoxInsetPct) return no('full_frame');

  // Frame coordinates → original coordinates. `pad` drew the original inset by the offsets,
  // so its origin is the negative offset; `crop` started at the frame's own position.
  const originX = frame.x || 0;
  const originY = frame.y || 0;

  const rawX = n.x * frame.w + originX;
  const rawY = n.y * frame.h + originY;
  const rawW = n.w * frame.w;
  const rawH = n.h * frame.h;

  // Anteil der BOX, nicht des Bildes — siehe `modelMarginPct`. Eine mit dem Auge
  // gezeichnete Box ist ungenauer als eine gemessene, und die Ungenauigkeit fällt bei dem
  // Teil an, der am weitesten absteht — im Verhältnis zum Gegenstand, nicht zum Foto.
  const mx = Math.round(rawW * o.modelMarginPct);
  const my = Math.round(rawH * o.modelMarginPct);
  const x = clamp(Math.round(rawX) - mx, 0, imgW);
  const y = clamp(Math.round(rawY) - my, 0, imgH);
  const w = clamp(Math.round(rawX + rawW) + mx, 0, imgW) - x;
  const h = clamp(Math.round(rawY + rawH) + my, 0, imgH) - y;

  // The box may land entirely inside the padding of a padded frame, and then there is
  // nothing of the original left to crop to.
  if (w <= 0 || h <= 0) return no('in_padding');

  // Wie breit würde der 4:5-Rahmen um diese Box? Dieselbe Rechnung wie in `chooseFrame`.
  // Muss er auf die Inseratsbreite hochgerechnet werden, wird das Bild weich — ab einem
  // Punkt so weich, dass die alte, weitere Aufnahme das bessere Inserat ist.
  const frameW = Math.max(w, h * o.aspect);
  if (frameW * o.maxUpscale < o.maxW) return no('too_small');

  return {
    box: {
      x, y, w, h,
      // The model looked at the picture and named the article. That is the one detection
      // allowed to be sure without the peel agreeing — see the `certain` note in objectBox.
      certain: true,
      touchesEdge: false,
      source: 'model'
    },
    reason: 'ok'
  };
}

/**
 * Output size for a frame: at most 1080×1350, aspect kept, NEVER upscaled. A 700 px wide
 * source stays 700 px wide — blowing it up adds bytes, not detail.
 */
export function targetSize(frameW, frameH, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const scale = Math.min(1, o.maxW / frameW, o.maxH / frameH);
  return { w: Math.round(frameW * scale), h: Math.round(frameH * scale) };
}

/**
 * RGBA → one luminance byte per pixel (Rec. 601), the input objectBox() expects.
 * Lives here rather than in the canvas adapter so the adapter holds no arithmetic.
 */
export function toGrayscale(rgba, w, h) {
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return gray;
}

/**
 * The colour to pad with: the median of the border ring, or white when that border is too
 * busy to be a reference (KONZEPT §5.2 — "bei unklarem Hintergrund Weiß").
 *
 * Padding onto the wrong colour draws a visible frame around the article, which looks like
 * a broken photo; white at least reads as deliberate.
 *
 * Takes RGBA (not the grayscale array) because the pad has to match the actual hue, and
 * returns a CSS colour so the canvas adapter holds no arithmetic.
 */
export function padColor(rgba, w, h, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const white = 'rgb(255,255,255)';
  if (!w || !h || !rgba || rgba.length < w * h * 4) return white;

  const at = (x, y) => (y * w + x) * 4;
  const channels = [[], [], []];
  const sample = (x, y) => {
    const p = at(x, y);
    for (let c = 0; c < 3; c++) channels[c].push(rgba[p + c]);
  };
  for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y++) { sample(0, y); sample(w - 1, y); }

  const rgb = channels.map(median);
  // Same instability test as objectBox: if the border spreads more than the tolerance,
  // there is no single background colour to speak of.
  const spread = median(channels[0].map((_, i) => Math.max(
    Math.abs(channels[0][i] - rgb[0]),
    Math.abs(channels[1][i] - rgb[1]),
    Math.abs(channels[2][i] - rgb[2])
  )));
  if (spread > o.bgTolerance) return white;
  return `rgb(${rgb.map(v => Math.round(v)).join(',')})`;
}

/**
 * Map a box found on the downscaled analysis image back to source coordinates.
 *
 * Rounds OUTWARDS on every edge: a box rounded inwards would clip the object by up to a
 * factor-of-`scale` worth of pixels, which is exactly the failure this module exists to
 * prevent.
 */
export function scaleBox(box, scale, srcW, srcH) {
  const x = clamp(Math.floor(box.x * scale), 0, srcW);
  const y = clamp(Math.floor(box.y * scale), 0, srcH);
  return {
    x,
    y,
    w: clamp(Math.ceil((box.x + box.w) * scale), 0, srcW) - x,
    h: clamp(Math.ceil((box.y + box.h) * scale), 0, srcH) - y,
    certain: box.certain,
    touchesEdge: box.touchesEdge
  };
}
