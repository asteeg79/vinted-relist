/**
 * Canvas adapter — the only place that touches pixels.
 *
 * It holds NO decisions: where the object is, which frame to use, how big the output may
 * be and which colour to pad with all come from lib/crop.js. This file decodes, draws and
 * encodes. That split is why the guarantee "a frame never cuts into the object" hangs on
 * a unit test rather than on a click-through.
 *
 * NOT UNIT-TESTED (KONZEPT §9) — there is no canvas under Node. Click it through in the
 * dry run after every change.
 */
import {
  objectBox, chooseFrame, targetSize, toGrayscale, scaleBox, padColor, modelBoxVerdict
} from '../lib/crop.js';
import { arrayBufferToBase64 } from '../lib/util.js';

/** Long edge of the image the object detection runs on. Small is the point: it is cheap. */
const ANALYSIS_EDGE = 200;

/**
 * Long edge of the copy that goes to the model.
 *
 * THIS NUMBER WAS WRONG, AND IT COST THE SIZE. It used to be 1024, with the note "more
 * resolution buys nothing there" — true for telling a hoodie from a sneaker, false for the
 * one job that actually needs pixels: reading four characters off a sewn-in label. And it
 * was worse than 1024 suggests, because the copy was rendered from the FINISHED listing
 * image, which `targetSize` already caps at 1080×1350. A neck label came out roughly 60 px
 * wide after two downscales and a q0.85 JPEG. No prompt can read that.
 *
 * 1568 is Anthropic's own threshold: images with a longer edge are downscaled server-side,
 * so anything above this costs bytes and buys nothing. Below it, every pixel counts — which
 * is why the model copy is now redrawn from the ORIGINAL bitmap instead of resampled from
 * the already-shrunken output. Same frame, same composition, 819×1024 → 1254×1568: half
 * again as many pixels per edge, 2.3× the area, and — the part that is hard to put a number
 * on but probably matters more — one resample and one JPEG pass instead of two.
 */
const AI_EDGE = 1568;
/** Output quality. No jitter: that exists only to defeat Vinted's duplicate hashing on a
 *  relist, and a new article is not a duplicate of anything. */
const QUALITY = 0.9;
/** Higher than the listing copy: this one is read, not looked at. */
const AI_QUALITY = 0.92;

/**
 * Turn one picked file into a listing-ready photo.
 *
 * `options.modelBox` + `options.previousFrame` re-run the whole thing with the ARTICLE BOX
 * the recognition drew instead of the one the background peel guessed. That second pass is
 * how the photographer's shoes leave the picture: the peel cannot know they are not part
 * of the article, and the model can. Refused if the box is implausible — then the first
 * pass's result stands (see `modelBoxVerdict`).
 *
 * Returns { url, blob, base64, mediaType, width, height, mode, reason, touchesEdge,
 * frame, boxSource, modelUrl, modelWidth, modelHeight, modelBytes, stats }.
 * `url` and `modelUrl` are object URLs — the caller revokes them.
 */
export async function prepare(file, options = {}) {
  // `from-image` is the whole point for phone photos: it applies the EXIF orientation to
  // the pixels. reencode() in the relist path does not set it, and does not need to —
  // Vinted's CDN images are already normalised.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const small = draw(bitmap, ANALYSIS_EDGE);
    const pixels = small.ctx.getImageData(0, 0, small.canvas.width, small.canvas.height).data;
    const gray = toGrayscale(pixels, small.canvas.width, small.canvas.height);

    const found = objectBox(gray, small.canvas.width, small.canvas.height);
    const heuristic = scaleBox(found, bitmap.width / small.canvas.width, bitmap.width, bitmap.height);

    // The model's box wins when there is a usable one — it is the only party here that
    // knows a shoe from a sleeve. `modelBoxVerdict` refuses anything implausible,
    // and then nothing changes.
    const verdict = options.modelBox
      ? modelBoxVerdict(options.modelBox, options.previousFrame, bitmap.width, bitmap.height)
      : { box: null, reason: 'not_offered' };
    const box = verdict.box || heuristic;

    const frame = chooseFrame(box, bitmap.width, bitmap.height);
    const target = targetSize(frame.w, frame.h);

    const fill = frame.mode === 'crop' ? null : padColor(pixels, small.canvas.width, small.canvas.height);

    // The listing copy: Vinted's size, the one that gets uploaded.
    const canvas = compose(bitmap, frame, target.w, target.h, fill);
    const blob = await toBlob(canvas, QUALITY);

    // The model copy: THE WHOLE PHOTO, uncropped.
    //
    // It used to be the finished listing image, and that was the bug behind "die Größe
    // wird nicht erkannt". The crop is decided by a background peel that has no idea what
    // the article is — on one real photo it kept 26 % of the frame and the size label was
    // in the 74 % it threw away. The model then dutifully reported `size_label: null`,
    // because by the time it looked, the label was gone.
    //
    // Showing the recogniser our own guess is backwards. It gets the photo as taken; where
    // the article sits is ITS answer (`article_box`), and the crop follows from that.
    const modelFrame = { mode: 'crop', x: 0, y: 0, w: bitmap.width, h: bitmap.height };
    const model = modelSize(bitmap.width, bitmap.height);
    const modelCanvas = compose(bitmap, modelFrame, model.w, model.h, null);
    const modelBlob = await toBlob(modelCanvas, AI_QUALITY);

    return {
      url: URL.createObjectURL(blob),
      blob,
      base64: arrayBufferToBase64(await modelBlob.arrayBuffer()),
      mediaType: 'image/jpeg',
      width: target.w,
      height: target.h,
      mode: frame.mode,
      reason: frame.reason,
      touchesEdge: frame.touchesEdge,
      // The frame the model's normalised box refers to. Since the model copy is the whole
      // photo, this is the identity frame — but it is passed explicitly rather than
      // assumed, so the mapping keeps working if the model copy is ever framed again.
      modelFrame,
      // The listing frame. Kept for the log and for anyone wanting to know what was cut.
      frame,
      boxSource: verdict.box ? 'model' : 'heuristic',
      /** Why the model's box was or was not used — see `modelBoxVerdict`. */
      boxReason: verdict.reason,
      // What the model actually receives, so "hat es das Etikett überhaupt sehen können?"
      // is answerable by looking instead of by guessing. The studio offers this URL as a
      // link next to the photo; the caller revokes it with `url`.
      modelUrl: URL.createObjectURL(modelBlob),
      modelWidth: model.w,
      modelHeight: model.h,
      modelBytes: modelBlob.size,
      // Passed through for the log: which numbers led to this decision. The thresholds
      // are meant to be calibrated against real photos (KONZEPT §12.2), and without these
      // "nothing peeled" is indistinguishable from "the object really fills the frame".
      stats: found.stats
    };
  } finally {
    bitmap.close?.();
  }
}

/** Draw a bitmap onto a canvas scaled to fit `maxEdge`, never upscaled. */
function draw(bitmap, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

/**
 * Draw the chosen frame onto a canvas of exactly w×h.
 *
 * One function for both copies, so the model never judges a composition the buyer will not
 * see. `fill` is the pad colour, or null for a crop.
 */
function compose(bitmap, frame, w, h, fill) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  if (fill == null) {
    ctx.drawImage(bitmap, frame.x, frame.y, frame.w, frame.h, 0, 0, w, h);
    return canvas;
  }
  // Pad: the source is drawn whole, centred, and the gap is filled — nothing is cut.
  const scale = w / frame.w;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(
    bitmap,
    Math.round(frame.offsetX * scale), Math.round(frame.offsetY * scale),
    Math.round(bitmap.width * scale), Math.round(bitmap.height * scale)
  );
  return canvas;
}

/**
 * The model copy's size: the frame at up to AI_EDGE on its long side, never upscaled.
 *
 * Never upscaled matters — inventing pixels the camera did not record makes the label
 * blurrier, not more legible, and costs tokens for the privilege.
 */
function modelSize(frameW, frameH) {
  const scale = Math.min(1, AI_EDGE / Math.max(frameW, frameH));
  return { w: Math.max(1, Math.round(frameW * scale)), h: Math.max(1, Math.round(frameH * scale)) };
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Bild konnte nicht kodiert werden.'))),
      'image/jpeg',
      quality
    );
  });
}
