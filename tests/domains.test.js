import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VINTED_HOSTS, tabMatchPatterns, apiMatchPatterns, isVintedHost } from '../lib/domains.js';

test('VINTED_HOSTS: contains key markets, no duplicates', () => {
  for (const h of ['vinted.de', 'vinted.fr', 'vinted.com', 'vinted.co.uk']) {
    assert.ok(VINTED_HOSTS.includes(h), `missing ${h}`);
  }
  assert.equal(new Set(VINTED_HOSTS).size, VINTED_HOSTS.length, 'no duplicates');
});

test('tabMatchPatterns: one wildcard pattern per host', () => {
  const p = tabMatchPatterns();
  assert.equal(p.length, VINTED_HOSTS.length);
  assert.ok(p.includes('https://*.vinted.de/*'));
});

test('apiMatchPatterns: scoped to /api/', () => {
  const p = apiMatchPatterns();
  assert.equal(p.length, VINTED_HOSTS.length);
  assert.ok(p.every(x => x.endsWith('/api/*')));
});

test('isVintedHost: accepts vinted ccTLDs, rejects others', () => {
  assert.ok(isVintedHost('www.vinted.de'));
  assert.ok(isVintedHost('vinted.fr'));
  assert.ok(isVintedHost('www.vinted.co.uk'));
  assert.ok(!isVintedHost('www.ebay.com'));
  assert.ok(!isVintedHost('notvinted.com'));
  assert.ok(!isVintedHost(''));
  assert.ok(!isVintedHost(null));
});
