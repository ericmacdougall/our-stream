// SPDX-License-Identifier: AGPL-3.0-only
import { getConstructionPlans, getMigrationPlans } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { targetSchemaVersion, withoutSchemaStatement } from './boss-bootstrap.js';

describe('pg-boss bootstrap', () => {
  it('derives the target schema version from pg-boss package metadata', () => {
    const v = targetSchemaVersion();
    expect(Number.isInteger(v) && v > 0).toBe(true);
  });
  it('strips only the CREATE SCHEMA statement and keeps function bodies intact', () => {
    const plan = withoutSchemaStatement(getConstructionPlans('pgboss'));
    expect(plan).not.toMatch(/CREATE SCHEMA/i);
    expect(plan).toMatch(/CREATE TABLE pgboss\.version/);
    // migration plans from an older version contain $function$-tagged bodies; the plan is sent whole
    const mig = withoutSchemaStatement(getMigrationPlans('pgboss', targetSchemaVersion() - 1));
    expect(mig.length).toBeGreaterThan(0);
    expect((mig.match(/\$function\$/g) ?? []).length % 2).toBe(0);
  });
});
