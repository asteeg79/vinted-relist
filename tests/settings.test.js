import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { DEFAULT_SETTINGS, getSettings, saveSettings, resetSettings } from '../lib/settings.js';

beforeEach(() => installChromeMock());

test('getSettings: returns defaults when nothing stored', async () => {
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
});

test('getSettings: merges stored over defaults', async () => {
  installChromeMock({ settings: { photoQuality: 0.7, deleteEnabled: false } });
  const s = await getSettings();
  assert.equal(s.photoQuality, 0.7);
  assert.equal(s.deleteEnabled, false);
  // untouched keys keep defaults
  assert.equal(s.verifyAfterCreate, DEFAULT_SETTINGS.verifyAfterCreate);
  assert.equal(s.cooldownWarnPerHour, DEFAULT_SETTINGS.cooldownWarnPerHour);
});

test('saveSettings: patches and persists', async () => {
  const next = await saveSettings({ cooldownWarnPerHour: 9 });
  assert.equal(next.cooldownWarnPerHour, 9);
  assert.equal((await getSettings()).cooldownWarnPerHour, 9);
});

test('saveSettings: successive patches accumulate', async () => {
  await saveSettings({ photoQuality: 0.8 });
  await saveSettings({ interestWarn: false });
  const s = await getSettings();
  assert.equal(s.photoQuality, 0.8);
  assert.equal(s.interestWarn, false);
});

test('resetSettings: returns to defaults', async () => {
  await saveSettings({ deleteEnabled: false });
  const s = await resetSettings();
  assert.deepEqual(s, DEFAULT_SETTINGS);
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
});
