import { withRetry } from './retry.js';
import { parseUrl, buildItemUploadPayload, extractInterest, pickPhotoUrl, photoOrientation, validationErrorsOf, describeValidationErrors, conditionId, sizeId, fieldProbe } from './item.js';
import { jitter } from './util.js';
import { ApiError } from './errors.js';
import { withWriteLock } from './write-lock.js';
import { gatesFor } from './gates.js';
import { livePort } from './live-port.js';

/**
 * The relist pipeline — the heart of the extension.
 *
 * GOAL: bump a listing to the top of search by re-creating it. Vinted ranks newer
 * listings higher, so "delete + recreate" is the manual trick this automates.
 *
 * SAFETY PRINCIPLE — create-then-delete, never the reverse:
 *   We always create the fresh listing FIRST and only delete the original AFTER the new
 *   one is confirmed. If anything fails midway, the user still has their original. We
 *   additionally (a) verify the new item is queryable before deleting, and (b) refuse to
 *   delete an item the logged-in user doesn't own.
 *
 * THE PORT: every effect — HTTP, chrome storage, cookies, the clock, uuid generation —
 * goes through the `port` argument (see lib/relist-port.js). It defaults to the live
 * adapter, so callers pass nothing; tests pass an in-memory adapter and can then assert
 * the thing that actually matters: that deleteItem is never reached on a failed create.
 * Pure transforms (parseUrl, buildItemUploadPayload, …) stay direct imports.
 *
 * PROGRESS: each phase publishes a {pct,label} via port.publishProgress so the popup +
 * on-page toast can render a live bar.
 */

// Markers Vinted/Cloudflare/Datadome put in a blocked response body.
const DATADOME_PATTERN = /captcha-delivery|__cf_chl|cf_chl|datadome|blocked/i;

// The photo download/upload loop occupies the 20%→75% band of the progress bar.
const PHOTO_START = 20;
const PHOTO_END = 75;

// Backoff schedule for re-fetching the just-created item. Vinted's backend needs a few
// seconds to make a new listing queryable, so we retry with growing waits before giving up.
// The last two waits stretch the window from 13.5s to 33.5s: a clone that is complete a few
// minutes later must not cost the user a duplicate because we stopped looking too early.
const VERIFY_DELAYS_MS = [1500, 2500, 4000, 5500, 8000, 12000];

/**
 * Run one pipeline step with consistent error handling.
 * On failure it logs the step name + HTTP status/body, and if the body looks like an
 * anti-bot block it rethrows a friendly, actionable message instead of the raw HTML.
 */
async function step(port, name, fn) {
  try {
    return await fn();
  } catch (e) {
    const info = { err: e.message, name: e.name };
    if (e instanceof ApiError) {
      info.status = e.status;
      info.body = typeof e.body === 'string' ? e.body.slice(0, 400) : null;
      if (typeof e.body === 'string' && DATADOME_PATTERN.test(e.body)) {
        await port.log(`step_blocked:${name}`, { status: e.status });
        const friendly = new Error('Anti-Bot-Schutz (Datadome/Cloudflare) hat den Request blockiert. Logge dich bei Vinted aus und wieder ein, dann nochmal versuchen.');
        friendly.name = 'BotBlocked';
        throw friendly;
      }
    }
    await port.log(`step_failed:${name}`, info);
    throw e;
  }
}

/**
 * Which payload field each rejected Vinted field was built from. Used to tell apart
 * "the user left this blank" from "we sent nothing because we could not read it".
 */
const FIELD_TO_PAYLOAD_KEY = { condition: 'status_id', size: 'size_id', color: 'color1_id' };

/**
 * Turn an ApiError carrying a Vinted validation_error body into a friendly, actionable
 * Error (field + message). Returns null if the error isn't a validation error, so the
 * caller can fall back to rethrowing the original.
 */
function toFriendlyValidationError(e, payload, editUrl) {
  const verrs = validationErrorsOf(e);
  if (!verrs?.length) return null;
  const human = describeValidationErrors(verrs);

  // If we sent nothing for a rejected field, the original almost certainly HAS a value
  // and we failed to read it — Vinted renames these fields from time to time. Telling the
  // user to go fill in a field that is already filled in just wastes their time.
  const unreadable = verrs.some(v => {
    const key = FIELD_TO_PAYLOAD_KEY[v.field];
    return key && payload?.item?.[key] == null;
  });

  // The "go fix your listing" advice is only useful with a way to get there — Vinted
  // requires new fields on old listings, so this branch is hit by items that were
  // perfectly valid when they were created.
  const where = editUrl ? ` Hier bearbeiten: ${editUrl}` : '';
  const advice = unreadable
    ? 'Diese Angaben konnten nicht aus dem Original gelesen werden — vermutlich hat Vinted die API-Feldnamen geändert. Bitte den Log kopieren und melden.'
    : `Bitte ergänze das fehlende Feld im Original-Artikel und versuche es erneut.${where}`;

  const err = new Error(`Vinted lehnt die Erstellung ab — ${human}. ${advice} (Das Original wurde NICHT gelöscht.)`);
  err.name = 'ValidationError';
  return err;
}

/**
 * Non-destructive pre-flight, called before the user commits.
 *
 * Fetches the item to surface its engagement counters (favourites/views/chats) and the
 * recent relist counts, then turns both — plus settings and the first-run flag — into
 * the ordered list of `gates` the UI must walk the user through. Deciding here rather
 * than in each UI is what keeps the popup and the on-page toast from drifting apart;
 * they only render what comes back.
 *
 * `interest` and `counts` are still returned raw so the popup can paint its counter
 * chips without a second storage read.
 */
export async function preflight(url, port = livePort) {
  const { domain, itemId } = parseUrl(url);
  const auth = await port.ensureAuth(domain, itemId);
  if (!auth.csrf || !auth.anonId) {
    throw new Error('Sitzung unvollständig. Lade die Vinted-Seite neu und versuche es erneut.');
  }
  // The three stored reads don't depend on the item, so they ride along with the fetch.
  const [src, counts, settings, confirmedDelete] = await Promise.all([
    port.fetchItem(domain, auth, itemId),
    port.relistCounts(),
    port.getSettings(),
    port.hasConfirmedDelete()
  ]);
  const interest = extractInterest(src);

  return {
    title: src.title,
    photoCount: (src.photos || []).length,
    interest,
    counts,
    gates: gatesFor({ interest, counts, settings, confirmedDelete })
  };
}

/**
 * The "one writing operation at a time" rule lives in lib/write-lock.js, SHARED with the
 * auto-listing's publish step (ADR-0007) — the invariant is one writer, not one relist.
 *
 * It used to be a per-tab boolean in the content script, which guarded one tab and left
 * the real holes open: two Vinted tabs, or a tab plus the popup, could start concurrent
 * runs that interleaved writes to the single `progress` record and relisted two items back
 * to back with none of the cooldown pacing in between.
 */

/**
 * The full destructive pipeline. Returns one of:
 *   - { oldId, newId, newUrl }                      success (original deleted)
 *   - { testMode, oldId, newId, newUrl, oldUrl }    test mode (original kept)
 *   - { partial, oldId, newId, newUrl, warning }    clone created but original NOT deleted
 * or throws for an outright failure (caught by the SW message handler). A call made while
 * another relist is running rejects with BusyError without touching anything.
 *
 * Because only one run can be in flight, any progress update necessarily belongs to it —
 * which is why the progress record needs no run identity.
 */
export async function relist(url, port = livePort) {
  return withWriteLock('relist', () => runRelist(url, port));
}

async function runRelist(url, port) {
  // Retries share the port's clock so a test's fake sleep keeps backoff instant.
  const retry = fn => withRetry(fn, { sleep: port.sleep });

  const settings = await port.getSettings();
  await port.publishProgress(2, 'Anmeldedaten prüfen…');
  const { domain, itemId } = parseUrl(url);
  const auth = await port.ensureAuth(domain, itemId);

  await port.log('start', { v: port.version(), itemId, domain, hasCsrf: !!auth.csrf, hasAnonId: !!auth.anonId });

  if (!auth.csrf) throw new Error('Could not find CSRF token. Open Vinted in a tab and reload.');
  if (!auth.anonId) throw new Error('Missing anon_id cookie. Open Vinted in a tab and reload.');

  // 1. Fetch the full, editable item (rich JSON with every field we must replay).
  await port.publishProgress(10, 'Artikeldaten laden…');
  const src = await step(port, 'fetchItem', () => retry(() => port.fetchItem(domain, auth, itemId)));
  await port.log('fetchItem_shape', {
    id: src.id, title: src.title,
    catalog_id: src.catalog_id, brand_id: src.brand_id, brand: src.brand,
    status_id: conditionId(src), size_id: sizeId(src), package_size_id: src.package_size_id,
    color1_id: src.color1_id, color2_id: src.color2_id,
    photoCount: (src.photos || []).length, price: src.price, currency: src.currency
  });

  const meVUid = auth.vUid ? parseInt(auth.vUid, 10) : null; // for the ownership safety check
  const photos = src.photos || [];
  if (!photos.length) throw new Error('Source listing has no photos.');

  // One upload-session UUID shared by every photo AND the create payload — Vinted ties
  // uploaded photos to this id, so they must all match.
  const uploadSessionId = port.newUploadSessionId();
  await port.log('upload_session', { id: uploadSessionId });

  // 2. For each photo: download → re-encode (defeat dup-detection) → upload. Sequential,
  //    with jitter between, to stay gentle on rate limits / anti-bot heuristics.
  const perPhoto = (PHOTO_END - PHOTO_START) / photos.length; // share of the bar per photo
  const uploadedPhotos = [];
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    await port.sleep(jitter(800, 1500));
    const photoUrl = pickPhotoUrl(photo);
    if (!photoUrl) throw new Error(`Photo ${i} has no URL.`);

    await port.publishProgress(PHOTO_START + i * perPhoto, `Foto ${i + 1}/${photos.length}: herunterladen…`);
    const blob = await step(port, `downloadPhoto[${i}]`, () => port.downloadPhoto(photoUrl));
    const encoded = await port.encodePhoto(blob, settings.photoQuality);
    await port.log('photo_blob', { i, downloadedSize: blob.size, encodedSize: encoded.size, encodedType: encoded.type });

    await port.publishProgress(PHOTO_START + i * perPhoto + perPhoto / 2, `Foto ${i + 1}/${photos.length}: hochladen…`);
    const result = await step(port, `uploadPhoto[${i}]`,
      () => retry(() => port.uploadPhoto(domain, auth, encoded, `photo_${i}.jpg`, { preferItemId: itemId, tempUuid: uploadSessionId }))
    );
    // Carry the source orientation through so portrait photos aren't flipped.
    const orientation = photoOrientation(photo);
    uploadedPhotos.push({ ...result, orientation });
    await port.log('photo_uploaded', { i, id: result.id, orientation, temp_uuid: result.temp_uuid });
  }

  // 3. Build + POST the new item.
  await port.sleep(jitter(1500, 3000));
  await port.publishProgress(80, 'Neuer Artikel wird erstellt…');
  const payload = buildItemUploadPayload(src, uploadedPhotos, uploadSessionId);
  await port.log('create_payload_preview', {
    title: payload.item.title, catalog_id: payload.item.catalog_id,
    status_id: payload.item.status_id, photoCount: payload.item.assigned_photos.length,
    upload_session_id: payload.upload_session_id
  });
  const doCreate = () => step(port, 'createItem',
    () => retry(() => port.createItem(domain, auth, payload, { preferItemId: itemId }))
  );

  const editUrl = `https://${domain}/items/${itemId}/edit`;

  let newItem;
  try {
    newItem = await doCreate();
  } catch (e) {
    const verrs = validationErrorsOf(e);
    const colorErr = verrs?.find(v => v.field === 'color');

    // Vinted rejected a field. Log the source values it could have come from, so a
    // renamed or newly-required field is identifiable from a copied log. This fires ONLY
    // on a rejection: an item that legitimately has no size (a comic, say) is not a
    // problem and must not produce a scary log line.
    if (verrs?.length) {
      await port.log('create_rejected_probe', {
        rejected: verrs.map(v => v.field).join(','),
        probe: JSON.stringify(fieldProbe(src))?.slice(0, 900)
      });
    }

    // Auto-fix: the category now requires a colour but the source item had none.
    // Inject a neutral default ("Bunt"/15) and retry once. Only triggers on an actual
    // colour-validation error, so categories that don't need a colour stay untouched.
    if (colorErr && !payload.item.color_ids?.length) {
      const defColor = settings.defaultColorId; // DEFAULT_SETTINGS supplies the fallback
      payload.item.color_ids = [defColor];
      payload.item.color1_id = defColor;
      await port.log('auto_color_retry', { defaultColorId: defColor });
      try {
        newItem = await doCreate();
      } catch (e2) {
        throw toFriendlyValidationError(e2, payload, editUrl) || e2; // second failure → surface clearly
      }
    } else {
      throw toFriendlyValidationError(e, payload, editUrl) || e;
    }
  }
  await port.log('created', { newId: newItem.id });

  const newUrl = `https://${domain}/items/${newItem.id}`;

  // 4a. Test mode: stop here, keep the original, record the run.
  if (!settings.deleteEnabled) {
    await port.log('delete_skipped_test_mode', { oldId: itemId, newId: newItem.id });
    await port.publishProgress(100, 'Fertig (Test-Modus).');
    await port.recordRelist({ oldId: String(itemId), newId: String(newItem.id), title: src.title, domain, testMode: true });
    return { testMode: true, oldId: itemId, newId: newItem.id, newUrl, oldUrl: `https://${domain}/items/${itemId}` };
  }

  // 4b. Verify the new item is real & queryable before we delete anything.
  if (settings.verifyAfterCreate) {
    await port.publishProgress(88, 'Neuer Artikel wird verifiziert…');
    const verified = await verifyCreated(port, domain, auth, newItem.id);
    if (!verified.ok) {
      // Verification failed → keep the original (create-then-delete safety net).
      await port.publishProgress(100, verified.reason);
      return { partial: true, oldId: itemId, newId: newItem.id, newUrl, warning: verified.warning };
    }
  }

  await port.sleep(jitter(2000, 4000));
  await port.publishProgress(92, 'Original wird gelöscht…');

  // Final safety gate: never delete an item the current user doesn't own.
  const ownerCheck = src.user_id ?? src.seller_id;
  if (meVUid && ownerCheck && ownerCheck !== meVUid) {
    await port.log('ownership_mismatch_abort_delete', { vUid: meVUid, owner: ownerCheck });
    return { partial: true, oldId: itemId, newId: newItem.id, newUrl, warning: 'Ownership mismatch — original NOT deleted (safety abort). New listing was created.' };
  }

  // 5. Delete the original. A failure here is non-fatal — the clone already exists.
  try {
    await retry(() => port.deleteItem(domain, auth, itemId));
    await port.log('deleted', { oldId: itemId });
  } catch (e) {
    await port.log('delete_failed', { oldId: itemId, newId: newItem.id, err: e.message });
    await port.publishProgress(100, 'Klon erstellt, Löschen fehlgeschlagen.');
    return { partial: true, oldId: itemId, newId: newItem.id, newUrl, warning: 'New listing created, but deleting the original failed. Delete it manually.' };
  }

  await port.publishProgress(100, 'Fertig.');
  await port.recordRelist({ oldId: String(itemId), newId: String(newItem.id), title: src.title, domain, testMode: false });
  return { oldId: itemId, newId: newItem.id, newUrl };
}

/**
 * Re-fetch the just-created item, retrying with backoff for propagation delay.
 * Returns { ok: true } once it loads with photos, otherwise { ok:false, reason, warning }
 * describing why the original should be kept. A 0-photo reply is retried like a failed
 * fetch — it may just be the same propagation delay — and only counts as a data-mismatch
 * (the create likely didn't fully take) if the photos never appear.
 */
async function verifyCreated(port, domain, auth, newId) {
  let verified = null, lastErr = null;
  for (let attempt = 0; attempt < VERIFY_DELAYS_MS.length; attempt++) {
    await port.sleep(VERIFY_DELAYS_MS[attempt]); // wait first — the item isn't queryable instantly
    try {
      verified = await port.fetchItem(domain, auth, newId) ?? verified;
      if (verified?.photos?.length) break;
      await port.log('verify_retry', { attempt: attempt + 1, photos: 0 });
    } catch (e) {
      lastErr = e;
      await port.log('verify_retry', { attempt: attempt + 1, status: e.status, msg: e.message?.slice(0, 100) });
    }
  }
  if (!verified) {
    await port.log('verify_failed', { status: lastErr?.status, err: lastErr?.message?.slice(0, 200) });
    return { ok: false, reason: 'Klon erstellt, aber Verifikation fehlgeschlagen.', warning: 'Neuer Artikel angelegt, konnte aber nicht verifiziert werden. Original NICHT gelöscht — bitte manuell prüfen.' };
  }
  const verifiedPhotos = (verified.photos || []).length;
  await port.log('create_verified', { id: verified.id, photos: verifiedPhotos });
  if (verifiedPhotos === 0) {
    await port.log('verify_mismatch', { verifiedPhotos });
    return { ok: false, reason: 'Klon erstellt, aber Verifikation lieferte Daten-Mismatch.', warning: 'Neuer Artikel angelegt, aber Verifikation hat Ungereimtheiten gefunden. Original NICHT gelöscht.' };
  }
  return { ok: true };
}
