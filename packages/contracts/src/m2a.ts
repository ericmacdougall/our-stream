// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
// M2a API contract: documents. Additive to ./m1a.ts and ./m1b.ts (content create, upload, detail and
// org settings are extended there). Documents never appear in the feed or in the clip search
// (`/v1/search`); they have their own list, viewer, download and keyword search.
//
// Error codes added in M2a (ErrorResponse.error.code): `feature_disabled` (403: documents are off for the
// org, or the deployment kill switch is engaged), `file_too_large` (413), `unsupported_file_type` (400),
// `quota_exceeded` (429: org storage or per-user upload budget), `rate_limited` (429, reused),
// `already_completed` (409, reused: a completed upload is never completed twice).
// The viewer and the download answer an identical 404 `not_found` for every document the caller may not
// open (hidden, missing, other org, flag off, not a document).
import { z } from 'zod';
import { DocumentInfo, StreamKind, Uuid } from './m1a.js';
import { Cursor, EventTag, PageLimit } from './m1b.js';

const Count = z.number().int().nonnegative();
const Iso = z.iso.datetime();

/**
 * Where a chunk comes from in the original, derived from the chunk locator the parser wrote. Fields that
 * do not apply are null; `label` is a short human-readable form ("Page 3", "Slide 2", "Budget rows
 * 1-50", "Rows 1-50", or the heading text).
 */
export const DocumentAnchor = z.object({
  label: z.string(),
  page: z.number().int().positive().nullable(),
  slide: z.number().int().positive().nullable(),
  sheet: z.string().nullable(),
  rowStart: z.number().int().nonnegative().nullable(),
  rowEnd: z.number().int().nonnegative().nullable(),
  heading: z.string().nullable(),
});

// ---- viewer ----
export const DocumentViewerQuery = z.object({
  /** Opaque; the ordinal of the last chunk of the previous page. */
  cursor: Cursor.optional(),
  /** Chunks per page (default 200, at most 500). */
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
/** Consecutive chunks that share one anchor. Chunks of one section can overlap by about 100 characters. */
export const DocumentSection = z.object({
  anchor: DocumentAnchor,
  chunks: z.array(z.object({ ordinal: Count, text: z.string() })),
});
/**
 * Parsed text of the current version, plain text only (never the original's markup). The original is only
 * available through the attachment download.
 */
export const DocumentViewerResponse = z.object({
  id: Uuid,
  versionId: Uuid,
  title: z.string(),
  document: DocumentInfo,
  /** Relative path of the attachment download, e.g. `/v1/content/{id}/document/original`. */
  downloadPath: z.string(),
  sections: z.array(DocumentSection),
  nextCursor: z.string().nullable(),
});

// ---- per-stream Documents list ----
export const DocumentListQuery = z.object({ cursor: Cursor.optional(), limit: PageLimit });
export const DocumentListItem = z.object({
  id: Uuid,
  title: z.string(),
  description: z.string(),
  publishAt: Iso,
  owner: z.object({ id: Uuid, displayName: z.string() }),
  versionId: Uuid,
  document: DocumentInfo,
  tags: z.array(EventTag),
});
export const DocumentListResponse = z.object({
  items: z.array(DocumentListItem),
  nextCursor: z.string().nullable(),
});

// ---- keyword search over documents ----
export const DocumentSearchQuery = z.object({
  /**
   * Free text, up to 2,000 characters (400 `validation` above); NFC-normalised, control and zero-width
   * characters removed. Empty (after normalisation) answers 200 with no items. `websearch_to_tsquery` syntax
   * never errors. The text is never stored or logged (ADR-0013).
   */
  q: z.string().max(2000),
  cursor: Cursor.optional(),
  limit: PageLimit,
  streamId: Uuid.optional(),
  tag: EventTag.optional(),
});
export const DocumentSnippet = z.object({
  source: z.enum(['title', 'description', 'text']),
  /** Plain text, never markup. */
  text: z.string(),
  /** `[start, end)` UTF-16 code-unit ranges into `text`, ascending and non-overlapping. */
  ranges: z.array(z.tuple([Count, Count])),
  /** For `text` snippets: where in the original the passage is; null for title and description. */
  anchor: DocumentAnchor.nullable(),
});
export const DocumentSearchHit = z.object({
  id: Uuid,
  kind: z.literal('document'),
  title: z.string(),
  description: z.string(),
  publishAt: Iso,
  owner: z.object({ id: Uuid, displayName: z.string() }),
  versionId: Uuid,
  document: DocumentInfo,
  streams: z.array(z.object({ id: Uuid, name: z.string(), kind: StreamKind })),
  tags: z.array(EventTag),
  snippets: z.array(DocumentSnippet),
  /** `ts_rank_cd` normalised to 0..1; ties broken by `publishAt` desc. */
  score: z.number().min(0).max(1),
});
export const DocumentSearchResponse = z.object({
  items: z.array(DocumentSearchHit),
  /** Reader-visible matches for the whole query, capped at 1000. */
  total: Count,
  nextCursor: z.string().nullable(),
  authzEpoch: z.number().int(),
  orgContentEpoch: z.number().int(),
});
