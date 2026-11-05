// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  anchorFromLocator,
  canonicalMime,
  checkDocumentUpload,
  contentDisposition,
  formatOfName,
  parseSingleRange,
  sanitizeFileName,
} from './documents.js';
import { fromDbError } from './errors.js';
import { normalizeDocumentQuery } from './search-text.js';
import { settingsFromRaw, settingsToRaw } from './settings.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('document upload allow-list (AC-1)', () => {
  const ok: Array<[string, string, string]> = [
    ['report.pdf', 'application/pdf', 'pdf'],
    ['notes.docx', DOCX, 'docx'],
    ['deck.pptx', PPTX, 'pptx'],
    ['budget.xlsx', XLSX, 'xlsx'],
    ['data.csv', 'text/csv', 'csv'],
    ['data.csv', 'application/vnd.ms-excel', 'csv'],
    ['README.md', 'text/markdown', 'md'],
    ['README.markdown', 'text/plain', 'md'],
    ['UPPER.PDF', 'application/pdf', 'pdf'],
  ];
  it.each(ok)('accepts %s declared as %s', (name, mime, format) => {
    const v = checkDocumentUpload(name, mime);
    expect(v.ok && v.format).toBe(format);
  });

  const refused: Array<[string, string]> = [
    ['old.doc', 'application/msword'],
    ['old.ppt', 'application/vnd.ms-powerpoint'],
    ['old.xls', 'application/vnd.ms-excel'],
    ['macro.docm', DOCX],
    ['page.html', 'text/html'],
    ['image.svg', 'image/svg+xml'],
    ['archive.zip', 'application/zip'],
    ['noextension', 'application/pdf'],
    ['trailingdot.', 'application/pdf'],
    ['.pdf', 'application/pdf'],
    ['report.pdf', DOCX], // declared type does not match the extension
    ['report.docx', 'application/pdf'],
    ['sheet.xlsx', 'application/vnd.ms-excel'], // ms-excel is accepted for .csv only
    ['report.pdf', 'application/octet-stream'],
    // a bidi override is dropped before the extension is read, so this is an .exe
    ['evil.pdf‮gpj.exe', 'application/pdf'],
  ];
  it.each(refused)('refuses %s declared as %s', (name, mime) => {
    const v = checkDocumentUpload(name, mime);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.code).toBe('unsupported_file_type');
  });
});

// Control characters, DEL, path separators, zero-width space and the bidi override (by code point, so this
// file carries no raw control characters).
const hasUnsafeChar = (s: string) =>
  [...s].some((ch) => {
    const c = ch.codePointAt(0)!;
    return c < 0x20 || c === 0x7f || ch === '/' || ch === '\\' || c === 0x200b || c === 0x202e;
  });

describe('file name sanitising (NEG-9)', () => {
  it('removes control characters, separators, zero-width and bidi characters', () => {
    const name = sanitizeFileName('..\\..//a\u0000b\r\nc​d‮e.pdf');
    // leading dots go, each separator and control character becomes one underscore, zero-width and bidi vanish
    expect(name).toBe('_..__a_b__cde.pdf');
    expect(hasUnsafeChar(name)).toBe(false);
    expect(name.startsWith('.')).toBe(false);
  });
  it('normalises to NFC and bounds the length while keeping the extension', () => {
    expect(sanitizeFileName('café.pdf')).toBe('café.pdf');
    const long = sanitizeFileName(`${'x'.repeat(500)}.docx`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('.docx')).toBe(true);
  });
  it('a name that is only separators and dots has no extension and is refused', () => {
    expect(checkDocumentUpload('../../..', 'application/pdf').ok).toBe(false);
    expect(checkDocumentUpload('   ', 'application/pdf').ok).toBe(false);
  });
});

describe('Content-Disposition', () => {
  it('is an attachment with an ASCII fallback and an RFC 5987 name, never carrying CR, LF or quotes', () => {
    const h = contentDisposition('résumé "final";x.pdf');
    expect(h.startsWith('attachment; filename="')).toBe(true);
    expect(h).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22%3Bx.pdf");
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.split('"').length).toBe(3); // exactly one quoted string
  });
});

describe('chunk locators to viewer anchors', () => {
  it('reads page, slide, sheet with rows, rows, and heading locators', () => {
    expect(anchorFromLocator({ page: 3 })).toMatchObject({ label: 'Page 3', page: 3 });
    expect(anchorFromLocator({ slide: 2 })).toMatchObject({ label: 'Slide 2', slide: 2 });
    expect(anchorFromLocator({ sheet: 'Budget', row_start: 1, row_end: 50 })).toMatchObject({
      label: 'Budget rows 1-50',
      sheet: 'Budget',
      rowStart: 1,
      rowEnd: 50,
    });
    expect(anchorFromLocator({ row_start: 7, row_end: 7 })).toMatchObject({ label: 'Row 7' });
    expect(anchorFromLocator({ rows: [10, 20] })).toMatchObject({ label: 'Rows 10-20' });
    expect(anchorFromLocator({ heading: 'Scope' })).toMatchObject({
      label: 'Scope',
      heading: 'Scope',
    });
  });
  it('never fails on a malformed locator (a parser change cannot break the viewer)', () => {
    for (const bad of [
      null,
      undefined,
      5,
      'x',
      [],
      { page: 'three' },
      { page: -1 },
      { page: 1.5 },
    ]) {
      expect(anchorFromLocator(bad).label).toBe('Text');
    }
  });
});

describe('single byte ranges', () => {
  it('parses closed, open and suffix ranges against the size', () => {
    expect(parseSingleRange(undefined, 100)).toBeNull();
    expect(parseSingleRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseSingleRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseSingleRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseSingleRange('bytes=0-9999', 100)).toEqual({ start: 0, end: 99 });
  });
  it('refuses multi-range, malformed and unsatisfiable ranges', () => {
    for (const bad of [
      'bytes=0-1,5-6',
      'bytes=-',
      'bytes=abc',
      'items=0-1',
      'bytes=100-',
      'bytes=9-3',
      'bytes=-0',
    ])
      expect(parseSingleRange(bad, 100), bad).toBe('invalid');
  });
});

describe('formats', () => {
  it('maps names to formats and formats to one canonical served type', () => {
    expect(formatOfName('a.markdown')).toBe('md');
    expect(formatOfName('a.exe')).toBeNull();
    expect(canonicalMime('csv')).toBe('text/csv');
    expect(canonicalMime('md')).toBe('text/markdown');
  });
});

describe('document query hygiene (NEG-7)', () => {
  it('NFD and NFC queries normalise to the same text', () => {
    expect(normalizeDocumentQuery('résumé')).toBe(normalizeDocumentQuery('résumé'));
  });
  it('drops zero-width and bidi characters instead of splitting words', () => {
    expect(normalizeDocumentQuery('bud​get⁠ re‮view﻿')).toBe('budget review');
  });
  it('turns controls into spaces, collapses whitespace and trims noise-only input to empty', () => {
    expect(normalizeDocumentQuery('a\u0000\t\nb')).toBe('a b');
    expect(normalizeDocumentQuery(' ​​ \u0007 ')).toBe('');
    expect(normalizeDocumentQuery('')).toBe('');
  });
  it('bounds the length at 2,000 characters', () => {
    expect(normalizeDocumentQuery('a'.repeat(5000)).length).toBe(2000);
  });
});

describe('documents flag in org settings', () => {
  it('only a JSON true or the string "true" counts; absent, false, and anything else is off', () => {
    expect(settingsFromRaw({ documents_enabled: true }).documentsEnabled).toBe(true);
    expect(settingsFromRaw({ documents_enabled: 'true' }).documentsEnabled).toBe(true);
    for (const off of [undefined, false, 'false', 'TRUE', 'yes', 1, 0, null, {}, []])
      expect(settingsFromRaw({ documents_enabled: off }).documentsEnabled, String(off)).toBe(false);
    expect(settingsFromRaw(null).documentsEnabled).toBe(false);
  });
  it('writes the key only when asked, so an unrelated PATCH never creates it', () => {
    const s = settingsFromRaw({ documents_enabled: true });
    expect('documents_enabled' in settingsToRaw(s)).toBe(false);
    expect(settingsToRaw(s, true)['documents_enabled']).toBe(true);
    // The other keys this API owns are always written.
    expect(Object.keys(settingsToRaw(s)).sort()).toEqual([
      'comments',
      'engagement',
      'privacy',
      'scan',
    ]);
  });
});

describe('database error mapping for documents', () => {
  const mapped = (message: string) =>
    fromDbError(new Error(message)) as { statusCode?: number; code?: string };
  it('maps the publish guard to 403 feature_disabled', () => {
    expect(mapped('content_publish: feature_disabled: documents are not enabled')).toMatchObject({
      statusCode: 403,
      code: 'feature_disabled',
    });
  });
  it('maps document_upload_complete refusals to the idempotent 409 and the retracted 409', () => {
    expect(mapped('document_upload_complete: not awaiting upload')).toMatchObject({
      statusCode: 409,
      code: 'already_completed',
    });
    expect(mapped('document_upload_complete: content not found or retracted')).toMatchObject({
      statusCode: 409,
      code: 'retracted',
    });
  });
  it('leaves other errors alone', () => {
    const err = new Error('connection reset');
    expect(fromDbError(err)).toBe(err);
  });
});
