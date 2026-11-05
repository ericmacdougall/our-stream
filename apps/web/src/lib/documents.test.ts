// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MAX_BYTES,
  checkDocumentFile,
  checkSearchQuery,
  documentErrorMessageId,
  failureMessageId,
  joinChunks,
  looksLikeDocument,
  mergeSections,
  originalDownloadHref,
  snippetParts,
  type Anchor,
  type Section,
} from './documents.js';

const OOXML = 'application/vnd.openxmlformats-officedocument';

describe('checkDocumentFile (mirrors the API allow-list)', () => {
  const cases: [string, string, string][] = [
    ['a.pdf', 'application/pdf', 'pdf'],
    ['a.docx', `${OOXML}.wordprocessingml.document`, 'docx'],
    ['a.pptx', `${OOXML}.presentationml.presentation`, 'pptx'],
    ['a.xlsx', `${OOXML}.spreadsheetml.sheet`, 'xlsx'],
    ['a.csv', 'text/csv', 'csv'],
    ['a.md', 'text/markdown', 'md'],
    ['a.markdown', '', 'md'],
  ];
  it.each(cases)('accepts %s', (name, type, format) => {
    const v = checkDocumentFile({ name, size: 10, type });
    expect(v).toMatchObject({ ok: true, format });
  });
  it('replaces an unusable browser type with the canonical type for the extension', () => {
    expect(checkDocumentFile({ name: 'a.md', size: 1, type: '' })).toMatchObject({
      mimeType: 'text/markdown',
    });
    expect(
      checkDocumentFile({ name: 'a.csv', size: 1, type: 'application/vnd.ms-excel' }),
    ).toMatchObject({
      mimeType: 'application/vnd.ms-excel',
    });
    expect(
      checkDocumentFile({ name: 'a.pdf', size: 1, type: 'application/octet-stream' }),
    ).toMatchObject({
      mimeType: 'application/pdf',
    });
  });
  it('refuses legacy Office files with their own reason', () => {
    for (const name of ['a.doc', 'a.PPT', 'a.xls'])
      expect(checkDocumentFile({ name, size: 1 })).toEqual({ ok: false, reason: 'legacy' });
  });
  it('refuses unknown or missing extensions and executables', () => {
    for (const name of ['a.exe', 'a.html', 'noext', '.pdf', 'a.pdf.exe', 'a.'])
      expect(checkDocumentFile({ name, size: 1 })).toEqual({ ok: false, reason: 'unsupported' });
  });
  it('judges a bidi-disguised name by its real ending', () => {
    expect(checkDocumentFile({ name: 'evil.pdf\u202Egpj.exe', size: 1 })).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    // Format characters are dropped the way the API drops them, so the extension is what it will see.
    expect(checkDocumentFile({ name: 'a.p\u200Bdf', size: 1 })).toMatchObject({
      ok: true,
      format: 'pdf',
    });
    expect(checkDocumentFile({ name: 'a.pdf\u202E', size: 1 })).toMatchObject({ ok: true });
  });
  it('enforces the size cap exactly at 100 MiB and refuses empty files', () => {
    expect(checkDocumentFile({ name: 'a.pdf', size: DOCUMENT_MAX_BYTES })).toMatchObject({
      ok: true,
    });
    expect(checkDocumentFile({ name: 'a.pdf', size: DOCUMENT_MAX_BYTES + 1 })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(checkDocumentFile({ name: 'a.pdf', size: 0 })).toEqual({ ok: false, reason: 'empty' });
  });
  it('routes document-looking names (including legacy) away from the media path', () => {
    expect(looksLikeDocument('a.pdf')).toBe(true);
    expect(looksLikeDocument('a.doc')).toBe(true);
    expect(looksLikeDocument('a.mp4')).toBe(false);
  });
});

describe('error and failure mapping', () => {
  it('maps every M2a error code to its own message', () => {
    expect(documentErrorMessageId('feature_disabled')).toBe('error.featureDisabled');
    expect(documentErrorMessageId('unsupported_file_type')).toBe('error.unsupportedFileType');
    expect(documentErrorMessageId('file_too_large')).toBe('error.fileTooLarge');
    expect(documentErrorMessageId('quota_exceeded')).toBe('error.quotaExceeded');
    expect(documentErrorMessageId('already_completed')).toBe('error.alreadyCompleted');
    expect(documentErrorMessageId('rate_limited')).toBeUndefined();
    expect(documentErrorMessageId(undefined)).toBeUndefined();
  });
  it('maps known failure reasons and never echoes unknown text', () => {
    expect(failureMessageId('no_text')).toBe('documents.failure.noText');
    expect(failureMessageId('chunk_limit')).toBe('documents.failure.chunkLimit');
    expect(failureMessageId('<img src=x onerror=alert(1)>')).toBe('documents.failure.generic');
    expect(failureMessageId(null)).toBe('documents.failure.generic');
  });
});

const anchor = (label: string, extra: Partial<Anchor> = {}): Anchor => ({
  label,
  page: null,
  slide: null,
  sheet: null,
  rowStart: null,
  rowEnd: null,
  heading: null,
  ...extra,
});
const sec = (a: Anchor, ...ordinals: number[]): Section => ({
  anchor: a,
  chunks: ordinals.map((o) => ({ ordinal: o, text: `t${o}` })),
});

describe('mergeSections', () => {
  const p1 = anchor('Page 1', { page: 1 });
  const p2 = anchor('Page 2', { page: 2 });
  it('joins a section that continues across a page boundary', () => {
    const merged = mergeSections([sec(p1, 0, 1)], [sec(p1, 2), sec(p2, 3)]);
    expect(merged.map((s) => [s.anchor.label, s.chunks.map((c) => c.ordinal)])).toEqual([
      ['Page 1', [0, 1, 2]],
      ['Page 2', [3]],
    ]);
  });
  it('keeps different anchors that share a label apart', () => {
    const a = anchor('Text');
    const b = anchor('Text', { heading: 'Intro' });
    expect(mergeSections([sec(a, 0)], [sec(b, 1)])).toHaveLength(2);
  });
  it('skips chunks already shown and does not mutate its inputs', () => {
    const shown = [sec(p1, 0, 1)];
    const merged = mergeSections(shown, [sec(p1, 1, 2)]);
    expect(merged[0]?.chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(shown[0]?.chunks).toHaveLength(2);
  });
});

describe('snippetParts', () => {
  it('splits text on ranges and marks only the ranges', () => {
    expect(snippetParts('hello big world', [[6, 9]])).toEqual([
      { text: 'hello ', mark: false },
      { text: 'big', mark: true },
      { text: ' world', mark: false },
    ]);
  });
  it('treats markup as text and ignores bad ranges', () => {
    const text = '<b>x</b> <script>alert(1)</script>';
    const parts = snippetParts(text, [
      [3, 4],
      [2, 3], // out of order
      [0, 999], // out of bounds
      [5, 5], // empty
      [1.5, 2], // non integer
    ]);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(['x']);
  });
  it('does not split a surrogate pair', () => {
    const text = 'a\u{1F600}b';
    expect(snippetParts(text, [[2, 3]])).toEqual([{ text, mark: false }]);
    expect(snippetParts(text, [[1, 3]])).toEqual([
      { text: 'a', mark: false },
      { text: '\u{1F600}', mark: true },
      { text: 'b', mark: false },
    ]);
  });
  it('returns nothing for empty text', () => {
    expect(snippetParts('', [])).toEqual([]);
  });
});

describe('checkSearchQuery and downloads', () => {
  it('rejects blank and over-long queries and trims the rest', () => {
    expect(checkSearchQuery('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkSearchQuery(null)).toEqual({ ok: false, reason: 'empty' });
    expect(checkSearchQuery('x'.repeat(2001))).toEqual({ ok: false, reason: 'too_long' });
    expect(checkSearchQuery(' budget  ')).toEqual({ ok: true, q: 'budget' });
    expect(checkSearchQuery('x'.repeat(2000))).toMatchObject({ ok: true });
  });
  it('builds the download link from the id alone', () => {
    expect(originalDownloadHref('abc')).toBe('/api/v1/content/abc/document/original');
    expect(originalDownloadHref('a/../b')).toBe('/api/v1/content/a%2F..%2Fb/document/original');
  });
});

describe('joinChunks', () => {
  const body =
    'The quarterly budget covers hiring, travel and tooling for every team in the company.';
  it('drops the repeated overlap between neighbouring chunks', () => {
    const a = `Intro paragraph. ${body}`;
    const b = `${body} Next paragraph starts here.`;
    expect(joinChunks([{ text: a }, { text: b }])).toBe(
      `Intro paragraph. ${body} Next paragraph starts here.`,
    );
  });
  it('keeps short repeats and separates unrelated chunks', () => {
    expect(joinChunks([{ text: 'ha ha ha' }, { text: 'ha ha ha' }])).toBe('ha ha ha\n\nha ha ha');
    expect(joinChunks([{ text: 'one' }, { text: 'two' }])).toBe('one\n\ntwo');
    expect(joinChunks([])).toBe('');
  });
});
