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
  objectBox, chooseFrame, targetSize, toGrayscale, scaleBox, padColor
} from '../lib/crop.js';

/** Long edge of the image the object detection runs on. Small is the point: it is cheap. */
const ANALYSIS_EDGE = 200;
/** Long edge of the copy that goes to the model — more resolution buys nothing there. */
const AI_EDGE = 1024;
/** Output quality. No jitter: that exists only to defeat Vinted's duplicate hashing on a
 *  relist, and a new article is not a duplicate of anything. */
const QUALITY = 0.9;
const AI_QUALITY = 0.85;

/**
 * Turn one picked file into a listing-ready photo.
 *
 * Returns { url, blob, base64, mediaType, width, height, mode, reason, touchesEdge }.
 * `url` is an object URL for the preview — the caller revokes it.
 */
export async function prepare(file) {
  // `from-image` is the whole point for phone photos: it applies the EXIF orientation to
  // the pixels. reencode() in the relist path does not set it, and does not need to —
  // Vinted's CDN images are already normalised.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const small = draw(bitmap, ANALYSIS_EDGE);
    const pixels = small.ctx.getImageData(0, 0, small.canvas.width, small.canvas.height).data;
    const gray = toGrayscale(pixels, small.canvas.width, small.canvas.height);

    const found = objectBox(gray, small.canvas.width, small.canvas.height);
    const box = scaleBox(found, bitmap.width / small.canvas.width, bitmap.width, bitmap.height);
    const frame = chooseFrame(box, bitmap.width, bitmap.height);
    const target = targetSize(frame.w, frame.h);

    const canvas = document.createElement('canvas');
    canvas.width = target.w;
    canvas.height = target.h;
    const ctx = canvas.getContext('2d');
    const scale = target.w / frame.w;

    if (frame.mode === 'crop') {
      ctx.drawImage(bitmap, frame.x, frame.y, frame.w, frame.h, 0, 0, target.w, target.h);
    } else {
      // Pad: the source is drawn whole, centred, and the gap is filled — nothing is cut.
      ctx.fillStyle = padColor(pixels, small.canvas.width, small.canvas.height);
      ctx.fillRect(0, 0, target.w, target.h);
      ctx.drawImage(
        bitmap,
        Math.round(frame.offsetX * scale), Math.round(frame.offsetY * scale),
        Math.round(bitmap.width * scale), Math.round(bitmap.height * scale)
      );
    }

    const blob = await toBlob(canvas, QUALITY);
    return {
      url: URL.createObjectURL(blob),
      blob,
      base64: forModel(canvas),
      mediaType: 'image/jpeg',
      width: target.w,
      height: target.h,
      mode: frame.mode,
      reason: frame.reason,
      touchesEdge: frame.touchesEdge,
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

/** The finished photo, downscaled and base64-encoded for the recognition call. */
function forModel(source) {
  const scale = Math.min(1, AI_EDGE / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', AI_QUALITY).split(',')[1];
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
