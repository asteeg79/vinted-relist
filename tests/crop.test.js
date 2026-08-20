import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, objectBox, chooseFrame, targetSize, toGrayscale, scaleBox, padColor
} from '../lib/crop.js';

/**
 * Synthetic images only — no canvas, no DOM. `img()` paints a rectangle of `fg` onto a
 * background of `bg`, which is exactly the situation the object detection is built for:
 * a garment on a plain surface.
 */
function img(w, h, rect = null, { bg = 200, fg = 40, noise = 0 } = {}) {
  const px = new Uint8ClampedArray(w * h);
  // Deterministic pseudo-noise: a test that fails must fail the same way twice.
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      px[y * w + x] = (inside ? fg : bg) + (noise ? Math.round((rnd() - 0.5) * 2 * noise) : 0);
    }
  }
  return px;
}

/** Does `frame` (crop mode) fully contain `box`? The one thing that must never fail. */
function contains(frame, box) {
  return frame.x <= box.x
    && frame.y <= box.y
    && frame.x + frame.w >= box.x + box.w
    && frame.y + frame.h >= box.y + box.h;
}

// ---------- objectBox ----------

test('objectBox: finds a rectangle on a plain background', () => {
  const rect = { x: 60, y: 40, w: 80, h: 120 };
  const box = objectBox(img(200, 250, rect), 200, 250);
  assert.equal(box.certain, true);
  assert.equal(box.touchesEdge, false);
  // The box never sits inside the object: safety margin grows it outwards only.
  assert.ok(box.x <= rect.x && box.y <= rect.y, `box ${JSON.stringify(box)} starts after the object`);
  assert.ok(box.x + box.w >= rect.x + rect.w && box.y + box.h >= rect.y + rect.h);
});

test('objectBox: adds the safety margin on every edge', () => {
  const rect = { x: 60, y: 60, w: 80, h: 80 };
  const w = 200, h = 200;
  const box = objectBox(img(w, h, rect), w, h);
  const margin = Math.round(w * DEFAULTS.safetyMarginPct);
  assert.ok(rect.x - box.x >= margin - 1, `left margin ${rect.x - box.x} < ${margin}`);
  assert.ok((box.x + box.w) - (rect.x + rect.w) >= margin - 1);
});

test('objectBox: a light object on a dark background is found too', () => {
  const rect = { x: 50, y: 50, w: 60, h: 60 };
  const box = objectBox(img(200, 200, rect, { bg: 30, fg: 230 }), 200, 200);
  assert.equal(box.certain, true);
  assert.ok(box.x <= rect.x && box.x + box.w >= rect.x + rect.w);
});

test('objectBox: object touching the image edge is flagged', () => {
  // Photographed too close: the item runs out of frame on the left.
  const box = objectBox(img(200, 250, { x: 0, y: 40, w: 90, h: 120 }), 200, 250);
  assert.equal(box.touchesEdge, true);
  assert.equal(box.certain, true, 'the claim is only allowed off a confident detection');
});

test('objectBox: an uncertain detection makes no claim about the edge', () => {
  // The peel finds no margin — that says "nothing to trim here", not "the object runs
  // out of the frame". A shadow or a fold stops it just as reliably as the article.
  const box = objectBox(img(200, 200, { x: 1, y: 1, w: 198, h: 198 }), 200, 200);
  assert.equal(box.certain, false);
  assert.equal(box.touchesEdge, false, 'an uncertain box must not warn about the edge');
});

test('objectBox: uniform image has no object — uncertain, no crash', () => {
  const box = objectBox(img(120, 150, null), 120, 150);
  assert.equal(box.certain, false);
  assert.deepEqual({ x: box.x, y: box.y, w: box.w, h: box.h }, { x: 0, y: 0, w: 120, h: 150 });
});

test('objectBox: object filling almost the whole image is uncertain', () => {
  const box = objectBox(img(200, 200, { x: 1, y: 1, w: 198, h: 198 }), 200, 200);
  assert.equal(box.certain, false);
});

test('objectBox: a textured background is still readable — the tolerances adapt to it', () => {
  // The real case this exists for: a garment on a wooden floor, a carpet, a bed sheet.
  // Against a fixed threshold every row of such a surface looks like an object, nothing
  // peels, and the studio wrongly reports "the object touches the edge".
  const rect = { x: 70, y: 70, w: 60, h: 60 };
  const box = objectBox(img(200, 200, rect, { noise: 90 }), 200, 200);
  assert.equal(box.certain, true);
  assert.ok(box.x <= rect.x && box.y <= rect.y, `box ${JSON.stringify(box)} starts inside the object`);
  assert.ok(box.x + box.w >= rect.x + rect.w && box.y + box.h >= rect.y + rect.h);
  assert.equal(box.touchesEdge, false);
});

test('objectBox: a background with no signal left falls back to uncertain', () => {
  const box = objectBox(img(200, 200, { x: 70, y: 70, w: 60, h: 60 }, { noise: 200 }), 200, 200);
  assert.equal(box.certain, false);
});

test('objectBox: reports how it decided, so a wrong threshold is diagnosable', () => {
  const box = objectBox(img(200, 250, { x: 60, y: 40, w: 80, h: 120 }), 200, 250);
  assert.equal(typeof box.stats.bg, 'number');
  assert.equal(typeof box.stats.colourTol, 'number');
  assert.equal(typeof box.stats.energyTol, 'number');
  // All four sides at zero is the signature of thresholds too strict for the surface.
  assert.ok(box.stats.peel.top > 0 && box.stats.peel.left > 0, JSON.stringify(box.stats));
  assert.ok(box.stats.fillPct > 0 && box.stats.fillPct < 100);
});

test('objectBox: the tolerance never drops below the configured floor', () => {
  // A perfectly clean backdrop must not get a tolerance of nearly zero, or JPEG noise
  // alone would look like an object.
  const box = objectBox(img(200, 200, { x: 70, y: 70, w: 60, h: 60 }, { noise: 0 }), 200, 200);
  assert.equal(box.stats.colourTol, DEFAULTS.bgTolerance);
  assert.equal(box.stats.energyTol, DEFAULTS.edgeEnergy);
});

test('objectBox: mild sensor noise still leaves the detection certain', () => {
  const rect = { x: 70, y: 70, w: 60, h: 80 };
  const box = objectBox(img(200, 220, rect, { noise: 4 }), 200, 220);
  assert.equal(box.certain, true);
  assert.ok(box.x <= rect.x && box.y <= rect.y);
});

test('objectBox: never reports a box outside the image', () => {
  const w = 100, h = 100;
  const box = objectBox(img(w, h, { x: 2, y: 2, w: 96, h: 96 }), w, h);
  assert.ok(box.x >= 0 && box.y >= 0);
  assert.ok(box.x + box.w <= w && box.y + box.h <= h);
});

// ---------- chooseFrame ----------

test('chooseFrame: THE central guarantee — a crop frame never cuts into the object box', () => {
  const formats = [[200, 250], [250, 200], [300, 300], [400, 200], [180, 320]];
  for (const [w, h] of formats) {
    for (const rect of [
      { x: 10, y: 10, w: 40, h: 40 },
      { x: Math.floor(w / 3), y: Math.floor(h / 3), w: Math.floor(w / 4), h: Math.floor(h / 4) },
      { x: w - Math.floor(w / 5) - 5, y: 5, w: Math.floor(w / 6), h: Math.floor(h / 2) },
      { x: 2, y: h - Math.floor(h / 3) - 2, w: Math.floor(w / 2), h: Math.floor(h / 4) }
    ]) {
      const box = objectBox(img(w, h, rect), w, h);
      const frame = chooseFrame(box, w, h);
      if (frame.mode !== 'crop') continue;
      assert.ok(contains(frame, box),
        `${w}×${h} rect ${JSON.stringify(rect)}: frame ${JSON.stringify(frame)} cuts box ${JSON.stringify(box)}`);
      assert.ok(frame.x >= 0 && frame.y >= 0 && frame.x + frame.w <= w && frame.y + frame.h <= h,
        `frame ${JSON.stringify(frame)} leaves the image ${w}×${h}`);
    }
  }
});

test('chooseFrame: box plus margin fits a 4:5 frame → crop', () => {
  const w = 400, h = 500;
  const box = objectBox(img(w, h, { x: 140, y: 180, w: 120, h: 150 }), w, h);
  const frame = chooseFrame(box, w, h);
  assert.equal(frame.mode, 'crop');
  assert.ok(contains(frame, box));
  // 4:5 within a pixel of rounding
  assert.ok(Math.abs(frame.w / frame.h - DEFAULTS.aspect) < 0.01, `${frame.w}×${frame.h} is not 4:5`);
});

test('chooseFrame: no 4:5 frame fits around the box → pad, original pixels kept whole', () => {
  const w = 400, h = 200; // wide format, wide object: any 4:5 frame would cut it
  const box = objectBox(img(w, h, { x: 20, y: 40, w: 360, h: 120 }), w, h);
  const frame = chooseFrame(box, w, h);
  assert.equal(frame.mode, 'pad');
  assert.ok(frame.w >= w && frame.h >= h, 'padding must never shrink the source');
  assert.ok(frame.offsetX >= 0 && frame.offsetY >= 0);
  assert.ok(Math.abs(frame.w / frame.h - DEFAULTS.aspect) < 0.01);
});

test('chooseFrame: uncertain detection always pads, even when a crop would fit', () => {
  const w = 400, h = 500;
  const certain = objectBox(img(w, h, { x: 140, y: 180, w: 120, h: 150 }), w, h);
  assert.equal(chooseFrame(certain, w, h).mode, 'crop');
  // Same geometry, detection flagged uncertain → the safe way out.
  const frame = chooseFrame({ ...certain, certain: false }, w, h);
  assert.equal(frame.mode, 'pad');
  assert.equal(frame.reason, 'uncertain');
});

test('chooseFrame: a source already in 4:5 is left alone', () => {
  const w = 1080, h = 1350;
  const box = objectBox(img(w, h, { x: 300, y: 400, w: 400, h: 500 }), w, h);
  const frame = chooseFrame(box, w, h);
  assert.equal(frame.mode, 'crop');
  assert.ok(contains(frame, box));
});

test('chooseFrame: carries the edge warning through to the caller', () => {
  const w = 400, h = 500;
  const box = objectBox(img(w, h, { x: 0, y: 100, w: 200, h: 200 }), w, h);
  assert.equal(box.touchesEdge, true);
  assert.equal(chooseFrame(box, w, h).touchesEdge, true);
});

test('chooseFrame: a nonsensical box pads rather than producing a broken frame', () => {
  // NaN passes every comparison, so without an explicit check it would reach the canvas.
  const frame = chooseFrame({ x: 10, y: 10, w: NaN, h: 10, certain: true, touchesEdge: false }, 400, 500);
  assert.equal(frame.mode, 'pad');
  assert.ok(Number.isFinite(frame.w) && Number.isFinite(frame.h));
});

test('chooseFrame: pad frame is centred', () => {
  const w = 400, h = 200;
  const frame = chooseFrame({ x: 0, y: 0, w, h, certain: false, touchesEdge: false }, w, h);
  assert.equal(frame.mode, 'pad');
  assert.equal(frame.offsetX, Math.round((frame.w - w) / 2));
  assert.equal(frame.offsetY, Math.round((frame.h - h) / 2));
});

// ---------- targetSize ----------

test('targetSize: caps at 1080×1350', () => {
  assert.deepEqual(targetSize(2160, 2700), { w: 1080, h: 1350 });
});

test('targetSize: never upscales a small source', () => {
  assert.deepEqual(targetSize(800, 1000), { w: 800, h: 1000 });
  assert.deepEqual(targetSize(300, 375), { w: 300, h: 375 });
});

test('targetSize: keeps the aspect when scaling down', () => {
  const t = targetSize(4000, 5000);
  assert.equal(t.w, 1080);
  assert.equal(t.h, 1350);
});

test('targetSize: a non-4:5 frame still fits inside the bounds', () => {
  const t = targetSize(4000, 3000);
  assert.ok(t.w <= DEFAULTS.maxW && t.h <= DEFAULTS.maxH);
  assert.ok(Math.abs(t.w / t.h - 4000 / 3000) < 0.01);
});

// ---------- helpers used by the canvas adapter ----------

test('toGrayscale: reduces RGBA to one luminance byte per pixel', () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  const gray = toGrayscale(rgba, 2, 1);
  assert.equal(gray.length, 2);
  assert.equal(gray[0], 255);
  assert.equal(gray[1], 0);
});

test('scaleBox: maps a box from the analysis image back to the source, rounding outwards', () => {
  const box = { x: 10, y: 20, w: 30, h: 40, certain: true, touchesEdge: false };
  const scaled = scaleBox(box, 4, 1000, 1000);
  // Rounding outwards is the point: a box rounded inwards would clip the object.
  assert.ok(scaled.x <= 40 && scaled.y <= 80);
  assert.ok(scaled.x + scaled.w >= 160 && scaled.y + scaled.h >= 240);
  assert.equal(scaled.certain, true);
});

test('padColor: pads with the background the photo was shot on', () => {
  // Plain grey surface, object in the middle: the pad must match the surface.
  const rgba = new Uint8ClampedArray(40 * 40 * 4);
  for (let i = 0; i < 40 * 40; i++) {
    const inside = (i % 40) > 10 && (i % 40) < 30 && Math.floor(i / 40) > 10 && Math.floor(i / 40) < 30;
    rgba.set(inside ? [20, 20, 20, 255] : [200, 195, 190, 255], i * 4);
  }
  assert.equal(padColor(rgba, 40, 40), 'rgb(200,195,190)');
});

test('padColor: falls back to white when the border is too busy to read', () => {
  const rgba = new Uint8ClampedArray(40 * 40 * 4);
  let seed = 7;
  for (let i = 0; i < 40 * 40; i++) {
    // Take the high bits — an LCG's low bits barely move and would produce a flat image.
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const v = Math.floor((seed / 2147483648) * 256);
    rgba.set([v, v, v, 255], i * 4);
  }
  assert.equal(padColor(rgba, 40, 40), 'rgb(255,255,255)');
});

test('padColor: never throws on an empty or short buffer', () => {
  assert.equal(padColor(new Uint8ClampedArray(0), 0, 0), 'rgb(255,255,255)');
  assert.equal(padColor(new Uint8ClampedArray(8), 40, 40), 'rgb(255,255,255)');
});

test('scaleBox: clamps to the source bounds', () => {
  const box = { x: 0, y: 0, w: 50, h: 50, certain: true, touchesEdge: true };
  const scaled = scaleBox(box, 4, 200, 200);
  assert.equal(scaled.x, 0);
  assert.equal(scaled.y, 0);
  assert.ok(scaled.x + scaled.w <= 200 && scaled.y + scaled.h <= 200);
});
