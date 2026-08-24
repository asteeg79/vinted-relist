/**
 * The live DraftPort adapter — what the publish pipeline runs on inside the browser.
 *
 * Pure wiring, same rule as `live-port.js`: each member forwards to the module that owns
 * that behaviour. Anything with a decision in it belongs behind this file or in front of
 * it, never here. See lib/draft-port.js for the interface; signatures are declared in
 * full so the conformance check can compare arity.
 */
import * as pageApi from './page-api.js';
import { getSettings as readSettings } from './settings.js';
import { addEntry } from './history.js';
import { setProgress } from './progress.js';
import { DRAFT_STEPS, stepsAt } from './steps.js';
import { log as writeLog } from './logger.js';
import { ensureAuth as resolveAuth } from './auth.js';
import { hasConfirmedCreate } from './confirmation.js';
import { sleep as wait, uuidV4 } from './util.js';
import { base64ToBlob } from './image-utils.js';
import { lookupCachedCatalogs } from './taxonomy.js';

export const liveDraftPort = {
  ensureAuth: (domain) => resolveAuth(domain),

  uploadPhoto: (domain, auth, blob, filename, opts) => pageApi.uploadPhotoViaPage(domain, auth, blob, filename, opts),
  suggestCategories: (domain, auth, opts) => pageApi.suggestCategoriesViaPage(domain, auth, opts),
  suggestAttributes: (domain, auth, opts) => pageApi.suggestAttributesViaPage(domain, auth, opts),
  categoryAttributes: (domain, auth, catalogId) => pageApi.fetchCategoryAttributesViaPage(domain, auth, catalogId),
  suggestPackageSize: (domain, opts) => pageApi.suggestPackageSizeViaPage(domain, opts),
  createItem: (domain, auth, payload, opts) => pageApi.createItemViaPage(domain, auth, payload, opts),

  decodePhoto: (base64, mediaType) => base64ToBlob(base64, mediaType),

  lookupCatalogs: (ids) => lookupCachedCatalogs(ids),

  getSettings: () => readSettings(),
  recordDraft: (entry) => addEntry(entry),
  hasConfirmedCreate: () => hasConfirmedCreate(),

  sleep: (ms) => wait(ms),
  newUploadSessionId: () => uuidV4(),
  version: () => chrome.runtime.getManifest().version,

  publishProgress: (pct, label) => setProgress(pct, label, stepsAt(DRAFT_STEPS, pct)),
  log: (event, data) => writeLog(event, data)
};
