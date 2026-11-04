// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { targetSchemaVersion } from './boss-bootstrap.js';

describe('pg-boss bootstrap', () => {
  it('derives the target schema version from the construction plan', () => {
    const v = targetSchemaVersion();
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });
});
