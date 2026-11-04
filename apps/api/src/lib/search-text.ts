// SPDX-License-Identifier: AGPL-3.0-only
// Search helpers (ADR-0013): ts_headline output carries private-use sentinels that are turned into
// UTF-16 code-unit ranges here, so no markup ever leaves the API; the keyset cursor is
// (score, publish_at, id) encoded as base64url JSON.

export const HL_START = '\uE000';
export const HL_END = '\uE001';
/** ts_headline options; the sentinels are injected with chr() in SQL so they never travel as literals. */
export const HEADLINE_OPTIONS = 'MaxWords=24, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "';

export interface SnippetText {
  text: string;
  ranges: Array<[number, number]>;
}

/**
 * Converts marked headline text into plain text plus [start, end) ranges. Sentinels are stripped from the
 * source in SQL (translate), so an odd or nested marker sequence means something went wrong: the text is
 * returned without highlights rather than with misaligned ones (plan review F5).
 */
export function headlineToSnippet(marked: string): SnippetText {
  let text = '';
  const ranges: Array<[number, number]> = [];
  let open: number | null = null;
  let valid = true;
  for (const ch of marked) {
    if (ch === HL_START) {
      if (open !== null) valid = false;
      open = text.length;
    } else if (ch === HL_END) {
      if (open === null) valid = false;
      else if (text.length > open) ranges.push([open, text.length]);
      open = null;
    } else {
      text += ch;
    }
  }
  if (open !== null) valid = false;
  return { text, ranges: valid ? ranges : [] };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCORE_RE = /^(0|1)(\.\d{1,6})?$/;

export interface SearchCursor {
  score: string;
  publishAt: Date;
  id: string;
}

export function encodeSearchCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify([c.score, c.publishAt.toISOString(), c.id])).toString(
    'base64url',
  );
}

export function decodeSearchCursor(cursor: string): SearchCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [score, iso, id] = parsed as [unknown, unknown, unknown];
    if (typeof score !== 'string' || !SCORE_RE.test(score)) return null;
    if (typeof iso !== 'string' || typeof id !== 'string' || !UUID_RE.test(id)) return null;
    const publishAt = new Date(iso);
    if (Number.isNaN(publishAt.getTime())) return null;
    return { score, publishAt, id };
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-control-regex
const QUERY_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Normalises the user's query: NFC, control characters out, bounded length. */
export function normalizeQuery(q: string): string {
  return q.normalize('NFC').replace(QUERY_CONTROLS, ' ').trim().slice(0, 200);
}
