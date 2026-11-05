// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { pgvectorAtLeast, pinIndexName } from './pin-index.js';

describe('pgvector version gate', () => {
  it('requires 0.8.0 or later (iterative scan)', () => {
    for (const v of ['0.8.0', '0.8.1', '0.8.7', '0.10.0', '1.0.0', '0.8.0-dev'])
      expect(pgvectorAtLeast(v), v).toBe(true);
    for (const v of ['0.7.4', '0.7.99', '0.5.1', '0.0.1', '', 'x', '0.'])
      expect(pgvectorAtLeast(v), v).toBe(false);
  });
});

describe('pinIndexName', () => {
  it('uses the first eight hex digits, matching the default pin index created by migration 0013', () => {
    expect(pinIndexName('5a7e0001-0000-4000-8000-000000000001')).toBe('embedding_hnsw_5a7e0001');
    expect(pinIndexName('ABCDEF12-0000-4000-8000-000000000001')).toBe('embedding_hnsw_abcdef12');
  });
  it('refuses anything that is not a UUID (the name is spliced into DDL)', () => {
    for (const bad of [
      "x'; DROP TABLE org; --",
      '',
      '5a7e0001',
      '5a7e0001-0000-4000-8000-00000000000g',
    ])
      expect(() => pinIndexName(bad)).toThrow(/UUID/);
  });
});
