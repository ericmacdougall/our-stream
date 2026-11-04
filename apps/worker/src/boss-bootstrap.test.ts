// SPDX-License-Identifier: AGPL-3.0-only
import { getConstructionPlans, getMigrationPlans } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { splitPlan, targetSchemaVersion, withoutSchemaStatement } from './boss-bootstrap.js';

describe('pg-boss bootstrap', () => {
  it('derives the target schema version from pg-boss package metadata', () => {
    const v = targetSchemaVersion();
    expect(Number.isInteger(v) && v > 0).toBe(true);
  });

  it('asks pg-boss for a construction plan without the schema statement and keeps function bodies intact', () => {
    const plan = getConstructionPlans('pgboss', { createSchema: false });
    expect(plan).not.toMatch(/CREATE SCHEMA/i);
    expect(plan).toMatch(/CREATE TABLE pgboss\.version/);
    // the defensive strip also removes a schema statement if a plan still carries one
    expect(withoutSchemaStatement('CREATE SCHEMA IF NOT EXISTS x;\nSELECT 1;')).toBe('\nSELECT 1;');
    const mig = getMigrationPlans('pgboss', targetSchemaVersion() - 1);
    expect((mig.match(/\$function\$|\$\$/g) ?? []).length % 2).toBe(0);
  });

  it('splits a migration plan at its final COMMIT so CONCURRENTLY statements run outside the transaction (N3)', () => {
    const mig = getMigrationPlans('pgboss', targetSchemaVersion() - 1);
    const split = splitPlan(mig);
    expect(split.transactional).toMatch(/^\s*BEGIN;/);
    expect(split.transactional.trimEnd()).toMatch(/COMMIT;$/);
    expect(split.transactional).not.toMatch(/CONCURRENTLY/);
    expect(split.postCommit.length).toBeGreaterThan(0);
    // pg-boss 12.38 (schema 46) appends four concurrent index builds; any later version must keep
    // every trailing statement whole and in order.
    for (const statement of split.postCommit) {
      expect(statement).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
      expect(statement.endsWith(';')).toBe(true);
      expect(statement).not.toMatch(/\n--/);
    }
    expect(split.postCommit.join('\n')).toBe(
      mig
        .slice(mig.lastIndexOf('COMMIT;') + 'COMMIT;'.length)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('--'))
        .join('\n'),
    );
  });

  it('keeps a plan without a trailing section whole, and rejects CONCURRENTLY inside the transaction', () => {
    const construction = splitPlan(getConstructionPlans('pgboss', { createSchema: false }));
    expect(construction.postCommit).toEqual([]);
    expect(construction.transactional).toMatch(/CREATE TABLE pgboss\.version/);
    expect(splitPlan('SELECT 1;')).toEqual({ transactional: 'SELECT 1;', postCommit: [] });
    expect(() => splitPlan('BEGIN;\nCREATE INDEX CONCURRENTLY i ON t (c);\nCOMMIT;\n')).toThrow(
      /CONCURRENTLY/,
    );
    expect(
      splitPlan('BEGIN;\nSELECT 1;\nCOMMIT;\n-- note\nCREATE INDEX CONCURRENTLY a ON t (c);\n'),
    ).toEqual({
      transactional: 'BEGIN;\nSELECT 1;\nCOMMIT;',
      postCommit: ['CREATE INDEX CONCURRENTLY a ON t (c);'],
    });
  });
});
