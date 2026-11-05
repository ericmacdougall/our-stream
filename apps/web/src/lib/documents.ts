// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers for the M2a documents UI: the client-side upload pre-check (a mirror of the API's
// allow-list in apps/api/src/lib/documents.ts; the API stays the authority and re-checks everything),
// error and failure-reason mapping, viewer section merging and anchors, and safe snippet segments.
import type { z } from 'zod';
import type { DocumentInfo as DocumentInfoSchema } from '@our-stream/contracts';
import type { MessageId } from './i18n';

export type DocumentInfo = z.output<typeof DocumentInfoSchema>;

/** The `document` block of a content detail, present only for documents the caller may see. */
export function documentOf(detail: object): DocumentInfo | null {
  const d = (detail as { document?: DocumentInfo }).document;
  return d ?? null;
}

/** True while a published document can be opened: published, started and not expired. */
export function isLiveNow(
  detail: { state: string; publishAt: string | null; expiresAt: string | null },
  now: number = Date.now(),
): boolean {
  if (detail.state !== 'published') return false;
  if (detail.publishAt && Date.parse(detail.publishAt) > now) return false;
  if (detail.expiresAt && Date.parse(detail.expiresAt) <= now) return false;
  return true;
}

export const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
export const SEARCH_QUERY_MAX = 2000;

export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'md';

const OOXML = 'application/vnd.openxmlformats-officedocument';

/** Extension and declared MIME allow-list; the first MIME of a format is its canonical one. */
export const DOCUMENT_FORMATS: Record<DocumentFormat, { exts: string[]; mimes: string[] }> = {
  pdf: { exts: ['pdf'], mimes: ['application/pdf'] },
  docx: { exts: ['docx'], mimes: [`${OOXML}.wordprocessingml.document`] },
  pptx: { exts: ['pptx'], mimes: [`${OOXML}.presentationml.presentation`] },
  xlsx: { exts: ['xlsx'], mimes: [`${OOXML}.spreadsheetml.sheet`] },
  csv: {
    exts: ['csv'],
    mimes: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  },
  md: { exts: ['md', 'markdown'], mimes: ['text/markdown', 'text/x-markdown', 'text/plain'] },
};

export const LEGACY_OFFICE_EXTS: ReadonlySet<string> = new Set(['doc', 'ppt', 'xls']);

/** Value for the file input's `accept` attribute (documents only; callers append media types). */
export const DOCUMENT_ACCEPT = Object.values(DOCUMENT_FORMATS)
  .flatMap((f) => f.exts.map((e) => `.${e}`))
  .join(',');

// Same rules as the API: format characters (zero-width, bidi) and line/paragraph separators are dropped
// so "evil.pdf<RLO>gpj.exe" is judged by what it really ends with.
const NAME_DROP = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
const NAME_UNSAFE = /[\p{Cc}/\\:*?"<>|]/gu;

export function sanitizeFileName(raw: string): string {
  let name = raw.normalize('NFC').replace(NAME_DROP, '').replace(NAME_UNSAFE, '_');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  return name;
}

export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

function formatForExt(ext: string): DocumentFormat | null {
  return (
    (Object.keys(DOCUMENT_FORMATS) as DocumentFormat[]).find((f) =>
      DOCUMENT_FORMATS[f].exts.includes(ext),
    ) ?? null
  );
}

/** True when the name looks like a document (or a refused legacy Office file) rather than media. */
export function looksLikeDocument(fileName: string): boolean {
  const ext = extensionOf(sanitizeFileName(fileName));
  return ext !== null && (formatForExt(ext) !== null || LEGACY_OFFICE_EXTS.has(ext));
}

export type DocumentRefusal = 'legacy' | 'unsupported' | 'empty' | 'too_large';

export type DocumentVerdict =
  { ok: true; format: DocumentFormat; mimeType: string } | { ok: false; reason: DocumentRefusal };

/**
 * Pre-check for a picked file. `browserType` is what the browser reported (often empty or text/plain for
 * CSV and Markdown); a type that is not on the extension's allow-list is replaced by the canonical type
 * for the extension, because browsers guess badly. The extension decides the format.
 */
export function checkDocumentFile(file: {
  name: string;
  size: number;
  type?: string;
}): DocumentVerdict {
  const ext = extensionOf(sanitizeFileName(file.name));
  if (!ext) return { ok: false, reason: 'unsupported' };
  if (LEGACY_OFFICE_EXTS.has(ext)) return { ok: false, reason: 'legacy' };
  const format = formatForExt(ext);
  if (!format) return { ok: false, reason: 'unsupported' };
  if (file.size <= 0) return { ok: false, reason: 'empty' };
  if (file.size > DOCUMENT_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const declared = (file.type ?? '').toLowerCase();
  const allowed = DOCUMENT_FORMATS[format].mimes;
  const mimeType = allowed.includes(declared) ? declared : allowed[0]!;
  return { ok: true, format, mimeType };
}

const REFUSAL_MESSAGE: Record<DocumentRefusal, MessageId> = {
  legacy: 'documents.refusal.legacy',
  unsupported: 'documents.refusal.unsupported',
  empty: 'documents.refusal.empty',
  too_large: 'documents.refusal.tooLarge',
};

export function refusalMessageId(reason: DocumentRefusal): MessageId {
  return REFUSAL_MESSAGE[reason];
}

/** Why a document version failed to process, from `processingError`; unknown text is never shown raw. */
const FAILURE_MESSAGE: Record<string, MessageId> = {
  no_text: 'documents.failure.noText',
  chunk_limit: 'documents.failure.chunkLimit',
  superseded: 'documents.failure.superseded',
  too_large: 'documents.failure.tooLarge',
  unsupported: 'documents.failure.unsupported',
};

export function failureMessageId(reason: string | null | undefined): MessageId {
  return (reason && FAILURE_MESSAGE[reason]) || 'documents.failure.generic';
}

/** Maps document-specific API error codes; undefined means "use the generic mapping". */
const DOCUMENT_ERROR_MESSAGE: Record<string, MessageId> = {
  feature_disabled: 'error.featureDisabled',
  unsupported_file_type: 'error.unsupportedFileType',
  file_too_large: 'error.fileTooLarge',
  quota_exceeded: 'error.quotaExceeded',
  already_completed: 'error.alreadyCompleted',
};

export function documentErrorMessageId(code: string | undefined): MessageId | undefined {
  return code ? DOCUMENT_ERROR_MESSAGE[code] : undefined;
}

// ---- viewer sections ----

export interface Anchor {
  label: string;
  page: number | null;
  slide: number | null;
  sheet: string | null;
  rowStart: number | null;
  rowEnd: number | null;
  heading: string | null;
}
export interface Section {
  anchor: Anchor;
  chunks: { ordinal: number; text: string }[];
}

export function sameAnchor(a: Anchor, b: Anchor): boolean {
  return (
    a.label === b.label &&
    a.page === b.page &&
    a.slide === b.slide &&
    a.sheet === b.sheet &&
    a.rowStart === b.rowStart &&
    a.rowEnd === b.rowEnd &&
    a.heading === b.heading
  );
}

/**
 * Appends the next page of sections. The API groups consecutive chunks that share an anchor, so a section
 * can continue across a page boundary; merge it instead of rendering two headings for one anchor.
 * Chunks already shown (same ordinal, e.g. a retried page) are skipped.
 */
export function mergeSections(shown: Section[], next: Section[]): Section[] {
  const out: Section[] = shown.map((s) => ({ anchor: s.anchor, chunks: [...s.chunks] }));
  const seen = new Set(out.flatMap((s) => s.chunks.map((c) => c.ordinal)));
  for (const section of next) {
    const fresh = section.chunks.filter((c) => !seen.has(c.ordinal));
    if (fresh.length === 0) continue;
    for (const c of fresh) seen.add(c.ordinal);
    const last = out[out.length - 1];
    if (last && sameAnchor(last.anchor, section.anchor)) last.chunks.push(...fresh);
    else out.push({ anchor: section.anchor, chunks: fresh });
  }
  return out;
}

/** A stable, DOM-safe id for a section: ordinal of its first chunk (unique even when labels repeat). */
export function sectionId(section: Section): string {
  return `s-${section.chunks[0]?.ordinal ?? 0}`;
}

/** The first section per anchor kind label, for the viewer's table of anchors (jump links). */
export function anchorKind(anchor: Anchor): 'page' | 'slide' | 'sheet' | 'heading' | 'text' {
  if (anchor.page !== null) return 'page';
  if (anchor.slide !== null) return 'slide';
  if (anchor.sheet !== null) return 'sheet';
  if (anchor.heading !== null) return 'heading';
  return 'text';
}

// ---- safe snippets ----

export interface SnippetPart {
  text: string;
  mark: boolean;
}

/**
 * Splits plain snippet text into parts using the API's `[start, end)` UTF-16 ranges. The result is only
 * ever rendered as React text nodes (marks as <mark>), never as HTML. Ranges that are out of bounds,
 * unordered, overlapping, empty or that split a surrogate pair are ignored rather than trusted.
 */
export function snippetParts(
  text: string,
  ranges: readonly (readonly [number, number])[],
): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let cursor = 0;
  const splitsPair = (i: number) => {
    if (i <= 0 || i >= text.length) return false;
    const prev = text.charCodeAt(i - 1);
    const next = text.charCodeAt(i);
    return prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  };
  for (const [start, end] of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < cursor || end <= start || end > text.length) continue;
    if (splitsPair(start) || splitsPair(end)) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), mark: false });
    parts.push({ text: text.slice(start, end), mark: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), mark: false });
  return parts;
}

// ---- search query ----

export type QueryCheck = { ok: true; q: string } | { ok: false; reason: 'empty' | 'too_long' };

/** Validates before any request: blank or over-long queries never reach the API. */
export function checkSearchQuery(raw: string | null | undefined): QueryCheck {
  const q = (raw ?? '').normalize('NFC').trim();
  if (q === '') return { ok: false, reason: 'empty' };
  if (q.length > SEARCH_QUERY_MAX) return { ok: false, reason: 'too_long' };
  return { ok: true, q };
}

/** The attachment download URL for a document, built from the id only (never from response text). */
export function originalDownloadHref(contentId: string): string {
  return `/api/v1/content/${encodeURIComponent(contentId)}/document/original`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

const OVERLAP_MIN = 40;
const OVERLAP_MAX = 200;

/**
 * Joins the chunks of one section into display text. Neighbouring chunks overlap by about 100 characters
 * (the chunking rule), so a repeated prefix of at least 40 characters that equals the end of the text so
 * far is dropped; anything shorter is kept, so genuinely repeated short text is never removed.
 */
export function joinChunks(chunks: readonly { text: string }[]): string {
  let out = '';
  for (const { text } of chunks) {
    if (out === '') {
      out = text;
      continue;
    }
    let cut = 0;
    for (let k = Math.min(OVERLAP_MAX, text.length, out.length); k >= OVERLAP_MIN; k--) {
      if (out.endsWith(text.slice(0, k))) {
        cut = k;
        break;
      }
    }
    out += `${cut === 0 ? '\n\n' : ''}${text.slice(cut)}`;
  }
  return out;
}
