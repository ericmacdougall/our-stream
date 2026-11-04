// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
import { describe, expect, it } from 'vitest';
import { HealthResponse, SyncResponse } from './index.js';

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
});
