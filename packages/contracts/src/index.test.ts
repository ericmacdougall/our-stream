// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  HealthResponse,
  MagicLinkConsumeRequest,
  MagicLinkRequest,
  SyncResponse,
} from './index.js';

describe('contracts', () => {
  it('rejects a malformed health payload', () => {
    expect(
      HealthResponse.safeParse({ status: 'ok', version: '1', checks: { database: 'fine' } })
        .success,
    ).toBe(false);
  });
  it('accepts a valid sync payload and rejects negative epochs', () => {
    expect(
      SyncResponse.safeParse({
        authzEpoch: 1,
        orgContentEpoch: 4,
        serverTime: '2026-11-03T12:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      SyncResponse.safeParse({
        authzEpoch: -1,
        orgContentEpoch: 4,
        serverTime: '2026-11-03T12:00:00Z',
      }).success,
    ).toBe(false);
  });
  it('validates the optional magic-link binding fields', () => {
    const email = 'a@example.com';
    const challenge = 'A'.repeat(43);
    expect(MagicLinkRequest.safeParse({ email }).success).toBe(true);
    expect(MagicLinkRequest.safeParse({ email, clientChallenge: challenge }).success).toBe(true);
    for (const bad of [
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}+`,
    ])
      expect(MagicLinkRequest.safeParse({ email, clientChallenge: bad }).success).toBe(false);
    const token = 't'.repeat(30);
    expect(MagicLinkConsumeRequest.safeParse({ token }).success).toBe(true);
    expect(MagicLinkConsumeRequest.safeParse({ token, verifier: 'A'.repeat(43) }).success).toBe(
      true,
    );
    expect(MagicLinkConsumeRequest.safeParse({ token, verifier: 'A'.repeat(129) }).success).toBe(
      false,
    );
    expect(MagicLinkConsumeRequest.safeParse({ token, verifier: 'A'.repeat(42) }).success).toBe(
      false,
    );
  });
});
