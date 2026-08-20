/**
 * Die Veröffentlichungs-Pipeline — aus einem Draft wird ein Listing.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: a draft with an open or unconfirmed field
 * never reaches `createItem`. And it is enforced by RECOMPUTING the view here rather than
 * trusting a `canPublish` flag from the studio — the UI is the untested zone, so it does
 * not get to assert its own readiness. This is the counterpart to "deleteItem is never
 * reached when anything upstream failed" in relist.js.
 *
 * THE OUTCOMES (CONTEXT.md):
 *   Erfolg       photos uploaded, item created
 *   Trockenlauf  payload built and logged, nothing sent (draftCreateEnabled: false)
 *   Fehler       nothing came into being — even when photos were already uploaded.
 *                There is NO partial here: without an item, there is nothing the user has
 *                to resolve by hand. A retry re-uploads under a fresh temp_uuid.
 *
 * THE LOCK starts at the first photo upload, not before (§4.5) — preparation is free, and
 * it is shared with `relist()` (lib/write-lock.js).
 */
import { buildNewItemPayload } from './item.js';
import { draftView } from './draft-view.js';
import { applySuggestions } from './lookup.js';
import { languageForHost } from './domains.js';
import { withWriteLock } from './write-lock.js';
import { ValidationError } from './errors.js';
import { liveDraftPort } from './live-draft-port.js';

/** The photo upload occupies the 15%→70% band of the progress bar. */
const PHOTO_START = 15;
const PHOTO_END = 70;

/**
 * Publish one prepared draft.
 *
 * `request` is what the studio hands over:
 *   domain     the marketplace to publish on
 *   draft      everything draftView needs: analysis, resolved, confirmations, overrides,
 *              price, condition, photos (metadata only)
 *   photos     [{ base64, mediaType, filename }] — the cropped results, in display order
 *
 * Returns `{ newId, newUrl, title }`, or `{ dryRun: true, payload }` in the Trockenlauf.
 * Throws for everything else; nothing is left half-created.
 */
export async function publishDraft(request, port = liveDraftPort) {
  const { domain, draft = {}, photos = [] } = request || {};
  const settings = await port.getSettings();

  // --- 1. the gate, before anything is touched --------------------------------------
  const view = draftView({ ...draft, settings });
  if (!view.canPublish) {
    await port.log('publish_blocked', { blockers: view.blockers });
    throw new ValidationError(`Draft ist nicht vollständig: ${view.blockers.join(' · ')}`);
  }
  if (!photos.length) throw new ValidationError('Ein Inserat ohne Foto gibt es nicht.');

  // --- 2. the language check, still before the upload (§7.7) ------------------------
  const expected = languageForHost(domain);
  if (expected && settings.draftLanguage && expected !== settings.draftLanguage) {
    throw new ValidationError(
      `Die Texte sind auf "${settings.draftLanguage}", ${domain} erwartet "${expected}". ` +
      'Sprache in den Einstellungen ändern oder auf der passenden Domain veröffentlichen.'
    );
  }

  // Everything above is free. From here on it writes, so it takes the shared lock.
  return withWriteLock('publish', () => runPublish({ domain, draft, photos, view, settings }, port));
}

async function runPublish({ domain, draft, photos, view, settings }, port) {
  const auth = await port.ensureAuth(domain);
  if (!auth.csrf || !auth.anonId) {
    throw new ValidationError('Sitzung unvollständig. Öffne kurz Vinted und versuche es erneut.');
  }

  // --- 3. photos, all under one session id ------------------------------------------
  const uploadSessionId = port.newUploadSessionId();
  await port.log('publish_start', { v: port.version(), domain, photos: photos.length, uploadSessionId });
  await port.publishProgress(PHOTO_START, 'Fotos werden hochgeladen…');

  const uploaded = [];
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const blob = await port.decodePhoto(photo.base64, photo.mediaType || 'image/jpeg');
    const result = await port.uploadPhoto(domain, auth, blob, photo.filename || `foto-${i + 1}.jpg`, { tempUuid: uploadSessionId });
    uploaded.push(result);
    await port.log('publish_photo', { i, id: result.id });
    await port.publishProgress(
      PHOTO_START + ((PHOTO_END - PHOTO_START) * (i + 1)) / photos.length,
      `Foto ${i + 1}/${photos.length}`
    );
    // Evenly spaced uploads are a bot signal; the relist path paces the same way.
    if (i < photos.length - 1) await port.sleep(400);
  }

  // --- 4. Vinteds eigene Erkennung als Gegenprobe (Entscheidung C) -------------------
  const resolved = await crossCheckWithVinted({ domain, auth, draft, uploaded, uploadSessionId }, port);
  const checked = draftView({ ...draft, resolved, settings });
  if (!checked.canPublish) {
    await port.log('publish_conflict', { blockers: checked.blockers });
    throw new ValidationError(
      `Vinteds eigene Erkennung widerspricht: ${checked.blockers.join(' · ')}. ` +
      'Bitte im Studio prüfen und erneut veröffentlichen.'
    );
  }

  // --- 5. the payload ---------------------------------------------------------------
  await port.publishProgress(80, 'Inserat wird gebaut…');
  const field = key => checked.fields.find(f => f.key === key);
  const payload = buildNewItemPayload({
    title: checked.title,
    description: checked.description,
    catalogId: resolved.catalog?.id,
    brandId: resolved.brand?.id ?? null,
    brand: resolved.brand?.label ?? null,
    sizeId: resolved.size?.id ?? null,
    statusId: field('condition')?.value,
    colorIds: [resolved.color?.id].filter(v => v != null),
    packageSizeId: draft.packageSizeId ?? null,
    price: field('price')?.value,
    currency: draft.currency || 'EUR'
  }, uploaded, uploadSessionId);

  // --- 6. Trockenlauf: everything up to here ran, the POST does not ------------------
  if (!settings.draftCreateEnabled) {
    await port.log('publish_dry_run', { payload });
    await port.publishProgress(100, 'Trockenlauf — nichts gesendet.');
    return { dryRun: true, payload, title: checked.title };
  }

  // --- 7. create --------------------------------------------------------------------
  await port.publishProgress(90, 'Inserat wird erstellt…');
  const created = await port.createItem(domain, auth, payload, {});
  const newId = created?.item?.id ?? created?.id ?? null;
  if (!newId) throw new ValidationError('Vinted hat kein Inserat zurückgegeben.');

  const newUrl = `https://${domain}/items/${newId}`;
  await port.recordDraft({ ts: Date.now(), domain, newId, title: checked.title, price: payload.item.price });
  await port.log('publish_done', { newId });
  await port.publishProgress(100, 'Fertig.');
  return { newId, newUrl, title: checked.title };
}

/**
 * Ask Vinted what IT sees in the photos, and hold that against our resolution.
 *
 * This is the whole benefit of Entscheidung C: two independent recognisers, and a
 * disagreement is worth more than either one's confidence. A failure here is deliberately
 * NOT fatal — Vinted's suggestion endpoints are a convenience, and losing them must not
 * block a draft the user has already reviewed. The lookup's own resolution then stands.
 */
async function crossCheckWithVinted({ domain, auth, draft, uploaded, uploadSessionId }, port) {
  const resolved = draft.resolved || {};
  try {
    const imageMetadata = uploaded
      .map(p => ({ image_id: p.high_resolution?.id, orientation: '0' }))
      .filter(m => m.image_id);
    if (!imageMetadata.length) return resolved;

    const categoryIds = await port.suggestCategories(domain, auth, { imageMetadata, uploadSessionId });
    const attributes = await port.suggestAttributes(domain, auth, {
      imageMetadata, uploadSessionId, categoryId: resolved.catalog?.id ?? null
    });
    await port.log('publish_suggestions', {
      categories: categoryIds, brands: (attributes?.brands || []).map(b => b.id)
    });

    return applySuggestions(resolved, {
      catalog: { ids: categoryIds || [], candidates: await port.lookupCatalogs(categoryIds || []) },
      brand: { ids: (attributes?.brands || []).map(b => b.id), candidates: attributes?.brands || [] },
      color: { ids: (attributes?.colors || []).map(c => c.id), candidates: attributes?.colors || [] }
    });
  } catch (e) {
    await port.log('publish_suggestions_failed', { error: e.message });
    return resolved;
  }
}
