/**
 * The live RelistPort adapter — what the pipeline runs on inside the browser.
 *
 * Pure wiring by design: each member forwards to the module that already owns that
 * behaviour, so there is nothing here to unit-test beyond "does it still satisfy the
 * interface" (tests/relist-port.test.js checks exactly that). Keep it that way — any
 * logic that appears here belongs in the module behind it, or in relist.js in front.
 *
 * See lib/relist-port.js for the interface. Signatures are declared in full (no default
 * values, no rest params) so the conformance check can compare arity.
 */
import * as pageApi from './page-api.js';
import { fetchAsBlob, reencode } from './image-utils.js';
import { getSettings as readSettings } from './settings.js';
import { addEntry, getCounts } from './history.js';
import { setProgress } from './progress.js';
import { RELIST_STEPS, stepsAt } from './steps.js';
import { log as writeLog } from './logger.js';
import { ensureAuth as resolveAuth } from './auth.js';
import { hasConfirmedDelete } from './confirmation.js';
import { sleep as wait, uuidV4 } from './util.js';

export const livePort = {
  ensureAuth: (domain, itemId) => resolveAuth(domain, itemId),

  fetchItem: (domain, auth, itemId) => pageApi.fetchItemViaPage(domain, auth, itemId),
  uploadPhoto: (domain, auth, blob, filename, opts) => pageApi.uploadPhotoViaPage(domain, auth, blob, filename, opts),
  createItem: (domain, auth, payload, opts) => pageApi.createItemViaPage(domain, auth, payload, opts),
  deleteItem: (domain, auth, itemId) => pageApi.deleteItemViaPage(domain, auth, itemId),

  downloadPhoto: (url) => fetchAsBlob(url),
  encodePhoto: (blob, quality) => reencode(blob, quality),

  getSettings: () => readSettings(),
  recordRelist: (entry) => addEntry(entry),
  relistCounts: () => getCounts(),
  hasConfirmedDelete: () => hasConfirmedDelete(),

  sleep: (ms) => wait(ms),
  newUploadSessionId: () => uuidV4(),
  version: () => chrome.runtime.getManifest().version,

  // Der Adapter ist die eine Stelle, die weiß, WELCHE Pipeline hier läuft — deshalb wählt
  // er die Phasenliste. Die Port-Schnittstelle bleibt bei zwei Parametern.
  publishProgress: (pct, label) => setProgress(pct, label, stepsAt(RELIST_STEPS, pct)),
  log: (event, data) => writeLog(event, data)
};
