// SPDX-License-Identifier: AGPL-3.0-only
// Enumeration of every copy of the reader-visibility rule (M2a document gate). The rule lives once in
// readerVisibleSql and is copied by hand into SQL functions that never call it. This test reads
// packages/db/migrations/*.sql (the LATEST definition of each function) and every TypeScript caller of
// readerVisibleSql, and fails when a new copy appears or a known copy loses its document clause.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { documentGateSql, readerVisibleSql } from './sql.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const migrationsDir = join(root, 'packages/db/migrations');

/** Latest body per function name across migrations in order. */
function latestFunctionBodies(): Map<string, { file: string; body: string }> {
  const out = new Map<string, { file: string; body: string }>();
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const re =
      /CREATE (?:OR REPLACE )?FUNCTION\s+([a-z_0-9.]+)\s*\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$/g;
    for (let m = re.exec(sql); m; m = re.exec(sql)) out.set(m[1]!, { file, body: m[2]! });
  }
  return out;
}

/** Text keys of the visibility predicate (an alias-qualified column, so OLD./NEW. trigger code never matches). */
const KEYS: Array<[string, RegExp]> = [
  ['retracted_at IS NULL', /(?<![A-Za-z_])[a-z]\.retracted_at IS NULL/],
  ['v_retracted IS NULL', /v_retracted IS NULL/],
  [
    "state = 'published'",
    /(?<![A-Za-z_.])state\s*=\s*'published'|\b[a-z]\.state\s*=\s*'published'|v_state\s*=\s*'published'/,
  ],
  ['content_audience join', /FROM content_audience a\b/],
  ['publish_at <= now()', /publish_at\s*<=\s*now\(\)/],
];

/**
 * Every function whose latest definition contains one of the keys. `kind` says how it honours documents:
 * 'gate' = carries the document clause; 'early-return' = returns before touching documents;
 * 'guard' = refuses a draft-to-published transition while documents are off;
 * 'state-change' = an operator function that moves rows, not a reader-visibility copy;
 * 'author-path' = an authorAccessible-style moderator check (never a reader path; comment endpoints that
 * reveal existence still go through readerVisibleSql).
 */
const KNOWN: Record<
  string,
  { kind: 'gate' | 'early-return' | 'guard' | 'state-change' | 'author-path'; marker: string }
> = {
  platform_audience_of_content: { kind: 'gate', marker: 'documents_enabled_unchecked' },
  platform_digest_items: { kind: 'gate', marker: 'documents_enabled_unchecked' },
  platform_document_finish: { kind: 'gate', marker: 'documents_enabled_unchecked' },
  platform_version_update: { kind: 'early-return', marker: "v_kind = 'document'" },
  content_publish: { kind: 'guard', marker: 'documents_enabled_unchecked' },
  platform_documents_hide: { kind: 'state-change', marker: "c.kind = 'document'" },
  platform_documents_restore: { kind: 'state-change', marker: "state <> 'draft'" },
  comment_can_moderate: { kind: 'author-path', marker: "usa.role IN ('moderator', 'owner')" },
};

describe('document gate: SQL copies of the visibility rule', () => {
  const fns = latestFunctionBodies();

  it('finds the known functions (the enumeration itself is not vacuous)', () => {
    expect(fns.size).toBeGreaterThan(40);
    for (const name of Object.keys(KNOWN)) expect(fns.has(name), name).toBe(true);
    expect(fns.get('platform_audience_of_content')!.file).toBe('0013_m2a_documents_core.sql');
  });

  it('every function whose latest definition holds a predicate key is in the known list, and each honours documents', () => {
    const found: string[] = [];
    for (const [name, { body }] of fns) {
      const hits = KEYS.filter(([, re]) => re.test(body)).map(([k]) => k);
      if (hits.length === 0) continue;
      found.push(name);
      const known = KNOWN[name];
      expect(
        known,
        `${name} (latest in ${fns.get(name)!.file}) copies the visibility rule (${hits.join(', ')}) but is not in the enumeration; add the document clause and list it here`,
      ).toBeDefined();
      expect(
        body.includes(known!.marker),
        `${name} must contain ${known!.marker} (${known!.kind})`,
      ).toBe(true);
    }
    // Every known entry was actually found by its keys (a stale list entry also fails).
    expect(found.sort()).toEqual(Object.keys(KNOWN).sort());
  });

  it('platform_viewers_of_version carries the document clause although it joins state rows, not the predicate', () => {
    const body = fns.get('platform_viewers_of_version')!.body;
    expect(body).toContain("c.kind <> 'document'");
    expect(body).toContain('documents_enabled_unchecked');
    expect(fns.get('platform_viewers_of_version')!.file).toBe('0013_m2a_documents_core.sql');
  });

  it('control: a fabricated new copy is detected by the same keys', () => {
    const fake = `SELECT 1 FROM content c WHERE c.state = 'published' AND c.retracted_at IS NULL AND c.publish_at <= now()`;
    expect(KEYS.filter(([, re]) => re.test(fake)).length).toBeGreaterThanOrEqual(3);
    // OLD./NEW. trigger code is not a copy.
    expect(
      KEYS.some(([, re]) =>
        re.test('IF NEW.retracted_at IS NOT NULL AND OLD.retracted_at IS NULL'),
      ),
    ).toBe(false);
  });
});

describe('document gate: TypeScript callers of readerVisibleSql', () => {
  /** Non-test source files that embed readerVisibleSql, relative to the repo root. */
  const EXPECTED = [
    'apps/api/src/lib/content.ts',
    'apps/api/src/lib/m1b-sql.ts',
    'apps/api/src/routes/content.ts',
    'apps/api/src/routes/feed.ts',
    'apps/api/src/routes/media.ts',
    'apps/api/src/routes/react.ts',
    'apps/api/src/routes/search.ts',
  ];

  function walk(dir: string, acc: string[]): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx)$/.test(name) && !/\.(test|integration)\.tsx?$/.test(name)) acc.push(p);
    }
    return acc;
  }

  it('lists exactly the known callers; a new caller must be added here with a document-fixture test', () => {
    const callers = [...walk(join(root, 'apps'), []), ...walk(join(root, 'packages'), [])]
      .filter((f) => !f.includes(`${join('packages', 'authz')}${'/'}src${'/'}`) || false)
      .filter((f) => /readerVisibleSql\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f))
      .filter((f) => !f.startsWith('packages/authz/'))
      .sort();
    expect(callers).toEqual(EXPECTED);
  });

  it('the generated predicate embeds the document gate exactly once, and the gate names platform_documents_enabled', () => {
    const p = { org: '$1', user: '$2' };
    const sql = readerVisibleSql(p);
    const gate = documentGateSql(p);
    expect(sql.split(gate).length - 1).toBe(1);
    expect(gate).toContain('(SELECT platform_documents_enabled($1))');
    expect(gate).toContain("cv.status = 'current'");
    expect(gate).toContain("c.kind <> 'document'");
  });
});
