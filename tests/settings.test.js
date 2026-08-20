import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import {
  DEFAULT_SETTINGS, DEFAULT_DESCRIPTION_TEMPLATE, CONDITION_OPTIONS,
  getSettings, saveSettings, resetSettings
} from '../lib/settings.js';

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

// ---------- Auto-Listing (ADR-0007) ----------

test('auto-listing defaults: the dry run is the default, nothing is published unasked', async () => {
  const s = await getSettings();
  assert.equal(s.draftCreateEnabled, false);
});

test('auto-listing defaults: language, condition, thresholds and check mode', async () => {
  const s = await getSettings();
  assert.equal(s.draftLanguage, 'de');
  assert.equal(s.draftConditionDefault, 'very_good');
  assert.equal(s.draftMinPrice, 0);
  assert.equal(s.draftConfidenceThreshold, 0.8);
  assert.equal(s.cropCheckMode, 'all');
  assert.equal(s.draftDescriptionTemplate, DEFAULT_DESCRIPTION_TEMPLATE);
});

test('description template: names the facts, forbids measurements and condition prose', () => {
  assert.match(DEFAULT_DESCRIPTION_TEMPLATE, /Material/);
  assert.match(DEFAULT_DESCRIPTION_TEMPLATE, /Maße/);
  assert.match(DEFAULT_DESCRIPTION_TEMPLATE, /Zustand/);
});

test('a user who stored settings before auto-listing existed picks up the new defaults', async () => {
  installChromeMock({ settings: { deleteEnabled: false, photoQuality: 0.8 } });
  const s = await getSettings();
  assert.equal(s.draftCreateEnabled, false);
  assert.equal(s.draftConfidenceThreshold, 0.8);
  assert.equal(s.deleteEnabled, false); // their own choice survives
});

test('auto-listing patches accumulate alongside the relist ones', async () => {
  await saveSettings({ draftCreateEnabled: true });
  await saveSettings({ draftMinPrice: 12 });
  await saveSettings({ photoQuality: 0.7 });
  const s = await getSettings();
  assert.equal(s.draftCreateEnabled, true);
  assert.equal(s.draftMinPrice, 12);
  assert.equal(s.photoQuality, 0.7);
});

test('condition options: the pre-selected default is one of them', () => {
  assert.ok(CONDITION_OPTIONS.some(o => o.value === DEFAULT_SETTINGS.draftConditionDefault));
});

test('condition options: every entry has a value and visible copy, values are unique', () => {
  for (const o of CONDITION_OPTIONS) {
    assert.ok(o.value, 'option without a value');
    assert.ok(o.label, `option ${o.value} without a label`);
  }
  assert.equal(new Set(CONDITION_OPTIONS.map(o => o.value)).size, CONDITION_OPTIONS.length);
});

test('resetSettings puts the dry run back on', async () => {
  await saveSettings({ draftCreateEnabled: true, draftMinPrice: 30 });
  const s = await resetSettings();
  assert.equal(s.draftCreateEnabled, false);
  assert.equal(s.draftMinPrice, 0);
});
