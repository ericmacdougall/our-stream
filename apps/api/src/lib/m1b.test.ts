// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { redactQueryTerms } from '../app.js';
import { normalizeCommentBody, scanComment, scanVerdict } from './comment-text.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  headlineToSnippet,
  HL_END,
  HL_START,
  normalizeQuery,
} from './search-text.js';

describe('comment text', () => {
  it('normalises to NFC and strips control, bidi and zero-width characters but keeps ZWJ and newlines', () => {
    expect(normalizeCommentBody('cafe\u0301 \u0007x\u200B\u202E\uFEFF\n\t👩\u200D💻 end ')).toBe(
      'café x\n\t👩\u200D💻 end',
    );
    expect(normalizeCommentBody(' \u0007\u200B ')).toBe('');
    expect(normalizeCommentBody('e\u0301'.repeat(1000)).length).toBe(1000);
    // Markup is kept verbatim: the API never renders HTML.
    expect(normalizeCommentBody('<img src=x onerror=alert(1)>')).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('scanner names categories and detectors, never values; Luhn gates card numbers', () => {
    const f = scanComment('key AKIAIOSFODNN7EXAMPLE and mail me at a.b@example.com');
    expect(f.map((x) => x.detector).sort()).toEqual(['aws_access_key', 'email']);
    expect(JSON.stringify(f)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(scanComment('order 4111 1111 1111 1111 shipped').map((x) => x.detector)).toEqual([
      'card_number',
    ]);
    expect(scanComment('ticket 1234 5678 9012 3456 shipped')).toEqual([]); // fails Luhn
    expect(scanComment('nothing to see')).toEqual([]);
    expect(scanVerdict('block', f)).toEqual({ blocked: true, categories: ['secret', 'pii'] });
    expect(scanVerdict('warn', f).blocked).toBe(false);
    expect(scanVerdict('block', []).blocked).toBe(false);
  });
});

describe('search text', () => {
  it('turns headline sentinels into UTF-16 ranges and drops highlights on malformed markers', () => {
    const s = headlineToSnippet(
      `the ${HL_START}budget${HL_END} 👩\u200D💻 ${HL_START}plan${HL_END}`,
    );
    expect(s.text).toBe('the budget 👩\u200D💻 plan');
    expect(s.ranges.map(([a, b]) => s.text.slice(a, b))).toEqual(['budget', 'plan']);
    expect(s.ranges[1]![0]).toBe('the budget 👩\u200D💻 '.length); // UTF-16 units, not code points
    const bad = headlineToSnippet(`x ${HL_START}budget ${HL_START}y${HL_END}`);
    expect(bad.text).toBe('x budget y');
    expect(bad.ranges).toEqual([]);
    expect(headlineToSnippet(`${HL_START}${HL_END}empty`)).toEqual({ text: 'empty', ranges: [] });
  });

  it('search cursors round-trip and reject tampering', () => {
    const c = {
      score: '0.123456',
      publishAt: new Date('2026-11-04T00:00:00Z'),
      id: '00000000-0000-4000-8000-000000000000',
    };
    expect(decodeSearchCursor(encodeSearchCursor(c))).toEqual(c);
    expect(decodeSearchCursor('nope')).toBeNull();
    expect(
      decodeSearchCursor(
        Buffer.from(JSON.stringify(['1e9', c.publishAt.toISOString(), c.id])).toString('base64url'),
      ),
    ).toBeNull();
    expect(
      decodeSearchCursor(
        Buffer.from(JSON.stringify(['0.5', 'yesterday', c.id])).toString('base64url'),
      ),
    ).toBeNull();
  });

  it('normalises queries and redacts q from logged urls', () => {
    expect(normalizeQuery('  bud\u0000get  ')).toBe('bud get');
    expect(redactQueryTerms('/v1/search?q=secret%20term&limit=5')).toBe(
      '/v1/search?q=%5Bredacted%5D&limit=5',
    );
    expect(redactQueryTerms('/v1/feed?limit=5')).toBe('/v1/feed?limit=5');
    expect(redactQueryTerms('/v1/feed')).toBe('/v1/feed');
  });
});
