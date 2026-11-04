// SPDX-License-Identifier: AGPL-3.0-only
// ADR-0008 tests: every (policy, provider) combination either routes or refuses with the right reason.
import { describe, expect, it } from 'vitest';
import { checkPolicy, selectProvider } from './policy.js';
import { ProviderPolicyError, type OrgModelPolicy, type ProviderDescriptor } from './types.js';
import { fakeAsrDescriptor } from './asr/fake.js';
import { whisperHttpDescriptor } from './asr/whisper-http.js';

const base: Omit<ProviderDescriptor, 'id' | 'retentionClass' | 'trainingUse'> = {
  vendor: 'acme',
  capability: 'asr',
  models: [{ id: 'm' }],
  regions: ['us'],
  requiresContract: false,
  residencyNotes: '',
  sourceUrl: 'https://example.invalid',
  verifiedOn: '2026-11-03',
};
const selfHosted = fakeAsrDescriptor;
const zdr: ProviderDescriptor = {
  ...base,
  id: 'zdr',
  retentionClass: 'zdr_contractual',
  trainingUse: 'never',
};
const retained: ProviderDescriptor = {
  ...base,
  id: 'retained',
  retentionClass: 'default_retention',
  trainingUse: 'opt_out',
};
const trains: ProviderDescriptor = {
  ...base,
  id: 'trains',
  retentionClass: 'trains_by_default',
  trainingUse: 'default_on',
};

const open: OrgModelPolicy = { selfHostOnly: false, requireZdr: false };
const zdrOnly: OrgModelPolicy = { selfHostOnly: false, requireZdr: true };
const sovereign: OrgModelPolicy = { selfHostOnly: true, requireZdr: false };
const sovereignZdr: OrgModelPolicy = { selfHostOnly: true, requireZdr: true };

describe('checkPolicy (table)', () => {
  const table: [string, OrgModelPolicy, ProviderDescriptor, string | true][] = [
    ['open/self_hosted', open, selfHosted, true],
    ['open/zdr', open, zdr, true],
    ['open/retained', open, retained, true],
    ['open/trains', open, trains, 'training_use'],
    ['zdr/self_hosted', zdrOnly, selfHosted, true],
    ['zdr/zdr', zdrOnly, zdr, true],
    ['zdr/retained', zdrOnly, retained, 'retention_not_zdr'],
    ['zdr/trains', zdrOnly, trains, 'training_use'],
    ['sovereign/self_hosted', sovereign, selfHosted, true],
    ['sovereign/zdr', sovereign, zdr, 'not_self_hosted'],
    ['sovereign/retained', sovereign, retained, 'not_self_hosted'],
    ['sovereign/trains', sovereign, trains, 'training_use'],
    ['sovereign+zdr/self_hosted', sovereignZdr, selfHosted, true],
    ['sovereign+zdr/zdr', sovereignZdr, zdr, 'not_self_hosted'],
    ['sovereign+zdr/whisper', sovereignZdr, whisperHttpDescriptor, true],
    [
      'vendor allow-list excludes',
      { ...open, allowedVendors: ['someone-else'] },
      zdr,
      'vendor_not_allowed',
    ],
    ['vendor allow-list includes', { ...open, allowedVendors: ['acme'] }, zdr, true],
    ['region allow-list excludes', { ...open, allowedRegions: ['eu'] }, zdr, 'region_not_allowed'],
    ['region allow-list includes', { ...open, allowedRegions: ['us'] }, zdr, true],
    ['local providers satisfy any region', { ...open, allowedRegions: ['eu'] }, selfHosted, true],
    ['capability mismatch', open, { ...zdr, capability: 'embed' }, 'wrong_capability'],
  ];
  expect(table.length).toBeGreaterThan(0);
  it.each(table)('%s', (_name, policy, descriptor, expected) => {
    const d = checkPolicy(policy, descriptor, 'asr');
    if (expected === true) expect(d).toEqual({ allowed: true });
    else expect(d).toEqual({ allowed: false, reason: expected });
  });
});

describe('selectProvider', () => {
  const p = (d: ProviderDescriptor) => ({ descriptor: d });
  it('routes to the first allowed provider in configured order', () => {
    expect(selectProvider(open, [p(retained), p(zdr)], 'asr').descriptor.id).toBe('retained');
    expect(selectProvider(zdrOnly, [p(retained), p(zdr)], 'asr').descriptor.id).toBe('zdr');
  });
  it('never falls back silently: refuses with the first refusal reason', () => {
    expect(() => selectProvider(sovereign, [p(retained), p(zdr)], 'asr')).toThrow(
      ProviderPolicyError,
    );
    try {
      selectProvider(sovereign, [p(retained), p(zdr)], 'asr');
    } catch (err) {
      expect((err as ProviderPolicyError).reason).toBe('not_self_hosted');
      expect((err as ProviderPolicyError).providerId).toBe('retained');
    }
  });
  it('refuses when nothing is configured', () => {
    expect(() => selectProvider(open, [], 'asr')).toThrow(/no asr provider/);
  });
});
