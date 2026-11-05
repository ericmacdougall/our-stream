// SPDX-License-Identifier: AGPL-3.0-only
// M2a documents: upload allow-list, filename sanitising, the org flag and kill switch, viewer anchors and
// the attachment headers. Nothing here trusts the client's file name or MIME type: the declared type must
// match the extension's allow-list at presign, and the parser sniffs the real content (worker slice).
import type { z } from 'zod';
import type { DocumentAnchor, DocumentFormat } from '@our-stream/contracts';
import type { TenantClient } from '@our-stream/db';
import { forbidden } from './errors.js';

export type Anchor = z.infer<typeof DocumentAnchor>;
export type Format = z.infer<typeof DocumentFormat>;

const OOXML = 'application/vnd.openxmlformats-officedocument';

/**
 * Allow-list by extension and declared MIME. Legacy binary Office formats (.doc, .ppt, .xls) are refused
 * on purpose: they are macro carriers and the parsers only read OOXML. `application/vnd.ms-excel` is
 * accepted for `.csv` only because Windows browsers report CSV files with it; `text/plain` is accepted for
 * Markdown and CSV because browsers report no better type for them.
 */
export const DOCUMENT_FORMATS: Record<Format, { exts: string[]; mimes: string[] }> = {
  pdf: { exts: ['pdf'], mimes: ['application/pdf'] },
  docx: { exts: ['docx'], mimes: [`${OOXML}.wordprocessingml.document`] },
  pptx: { exts: ['pptx'], mimes: [`${OOXML}.presentationml.presentation`] },
  xlsx: { exts: ['xlsx'], mimes: [`${OOXML}.spreadsheetml.sheet`] },
  csv: {
    exts: ['csv'],
    mimes: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  },
  md: {
    exts: ['md', 'markdown'],
    mimes: ['text/markdown', 'text/x-markdown', 'text/plain'],
  },
};

export const LEGACY_OFFICE_EXTS = new Set(['doc', 'ppt', 'xls']);

// Format characters (Cf: zero-width, bidi overrides) and line/paragraph separators are dropped, so
// "evil.pdf<RLO>gpj.exe" is judged by what it really ends with; control characters, path separators and the
// characters Windows refuses in names become an underscore.
const NAME_DROP = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
const NAME_UNSAFE = /[\p{Cc}/\\:*?"<>|]/gu;

/** The display name we store: NFC, no control or format characters, no separators, bounded length. */
export function sanitizeFileName(raw: string): string {
  let name = raw.normalize('NFC').replace(NAME_DROP, '').replace(NAME_UNSAFE, '_');
  name = name.replace(/\s+/g, ' ').trim();
  // Leading dots hide files and ".." is a path component on some systems; trailing dots and spaces are
  // dropped by Windows.
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (name.length > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = `${[...name.slice(0, 200 - ext.length)].join('')}${ext}`;
  }
  return name;
}

export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export type DocumentVerdict =
  | { ok: true; format: Format; fileName: string }
  | { ok: false; code: 'unsupported_file_type'; message: string };

/** Validates a declared (file name, MIME type) pair for a document upload. */
export function checkDocumentUpload(rawName: string, mimeType: string): DocumentVerdict {
  const fileName = sanitizeFileName(rawName);
  const ext = extensionOf(fileName);
  if (!ext) return refuse('the file needs one of the supported extensions');
  if (LEGACY_OFFICE_EXTS.has(ext))
    return refuse(
      'legacy .doc, .ppt and .xls files are not supported; save as .docx, .pptx or .xlsx',
    );
  const format = (Object.keys(DOCUMENT_FORMATS) as Format[]).find((f) =>
    DOCUMENT_FORMATS[f].exts.includes(ext),
  );
  if (!format) return refuse('supported documents: PDF, DOCX, PPTX, XLSX, CSV and Markdown');
  if (!DOCUMENT_FORMATS[format].mimes.includes(mimeType.toLowerCase()))
    return refuse(`the declared type does not match a .${ext} file`);
  return { ok: true, format, fileName };
}

function refuse(message: string): DocumentVerdict {
  return { ok: false, code: 'unsupported_file_type', message };
}

/** The MIME type we serve a stored original with: the first (canonical) allow-listed type of its format. */
export function canonicalMime(format: Format): string {
  return DOCUMENT_FORMATS[format].mimes[0]!;
}

export function formatOfName(fileName: string): Format | null {
  const ext = extensionOf(fileName);
  if (!ext) return null;
  return (
    (Object.keys(DOCUMENT_FORMATS) as Format[]).find((f) =>
      DOCUMENT_FORMATS[f].exts.includes(ext),
    ) ?? null
  );
}

/**
 * Org flag and deployment kill switch in one question, evaluated by the database (it asserts the org equals
 * the tenant context). An absent or non-'true' flag is off.
 */
export async function documentsEnabled(client: TenantClient): Promise<boolean> {
  const r = await client.query<{ on: boolean }>('SELECT platform_documents_enabled($1) AS "on"', [
    client.tenant.orgId,
  ]);
  return r.rows[0]?.on === true;
}

export async function requireDocumentsEnabled(client: TenantClient): Promise<void> {
  if (!(await documentsEnabled(client)))
    throw forbidden('feature_disabled', 'documents are not enabled for this organisation');
}

export async function killSwitchEngaged(client: TenantClient): Promise<boolean> {
  const r = await client.query<{ on: boolean }>(
    'SELECT platform_documents_kill_switch_engaged() AS "on"',
  );
  return r.rows[0]?.on === true;
}

// ---- viewer anchors -------------------------------------------------------------------------------

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.slice(0, 300) : null;

/**
 * Reads the chunk locator the parser wrote (docs/documents.md "Chunk locators"): `page`, `slide`, `sheet`,
 * `row_start`/`row_end` (also `rows: [start, end]`) and `heading`. Unknown or malformed locators give an
 * anchor with the label "Text" so a parser change can never break the viewer or leak raw jsonb.
 */
export function anchorFromLocator(locator: unknown): Anchor {
  const l = (typeof locator === 'object' && locator !== null ? locator : {}) as Record<
    string,
    unknown
  >;
  const rows = Array.isArray(l['rows']) ? (l['rows'] as unknown[]) : [];
  const page = num(l['page']);
  const slide = num(l['slide']);
  const sheet = str(l['sheet']);
  const rowStart = num(l['row_start'] ?? l['rowStart'] ?? rows[0]);
  const rowEnd = num(l['row_end'] ?? l['rowEnd'] ?? rows[1]);
  const heading = str(l['heading']);
  const rowText =
    rowStart !== null
      ? rowEnd !== null && rowEnd !== rowStart
        ? `rows ${rowStart}-${rowEnd}`
        : `row ${rowStart}`
      : null;
  let label = 'Text';
  if (page !== null && page > 0) label = `Page ${page}`;
  else if (slide !== null && slide > 0) label = `Slide ${slide}`;
  else if (sheet) label = rowText ? `${sheet} ${rowText}` : sheet;
  else if (rowText) label = rowText.charAt(0).toUpperCase() + rowText.slice(1);
  else if (heading) label = heading;
  return {
    label,
    page: page !== null && page > 0 ? page : null,
    slide: slide !== null && slide > 0 ? slide : null,
    sheet,
    rowStart,
    rowEnd,
    heading,
  };
}

export const anchorKey = (a: Anchor): string =>
  JSON.stringify([a.page, a.slide, a.sheet, a.rowStart, a.rowEnd, a.heading]);

// ---- attachment headers ---------------------------------------------------------------------------

/** `attachment` with an ASCII fallback and an RFC 5987 `filename*` for the real name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Headers that make a stored original inert in the browser (NEG-9). */
export const ATTACHMENT_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
} as const;

export type ByteRange = { start: number; end: number };

/**
 * Parses a single `bytes=` range against a known size. Returns null for no header, 'invalid' for a range
 * we refuse (multi-range, malformed, or outside the object): the caller answers 416.
 */
export function parseSingleRange(
  header: string | undefined,
  size: number,
): ByteRange | null | 'invalid' {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return 'invalid';
  return { start, end };
}
