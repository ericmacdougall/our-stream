// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic chunker (spec: documents target 800 characters with 100 overlap, split at headings and
// paragraphs). Pure and total: the same blocks always give the same chunks.
//
// Rules, in the order they apply:
//  * a chunk never spans a page, slide or sheet change (the "unit"); the overlap is not carried across one;
//  * a heading block flushes the open chunk and is prepended to the next paragraph when both fit in the
//    target (otherwise it becomes a chunk of its own); the overlap is not carried across a heading;
//  * paragraphs are joined with a blank line; a chunk is flushed when the next paragraph would exceed the
//    target, and the next chunk starts with the last <= 100 characters of the flushed one, cut at a word
//    boundary (dropped when it would push the first paragraph over the target);
//  * a paragraph longer than the target is cut into windows of at most the target, broken at whitespace,
//    each window starting up to 100 characters before the previous one ended;
//  * row blocks (CSV and XLSX) are joined with a newline into disjoint row ranges (no overlap, so a row
//    range is exact); a single row longer than the target is windowed like a long paragraph.
// Every chunk text is at most the target, so it is far below the database limit of 8,000 characters.
import { CHUNK_OVERLAP_CHARS, CHUNK_TARGET_CHARS } from './limits.js';
import type { Block, Locator } from './protocol.js';
import { normalizeParagraph, wellFormed } from './text.js';

export interface Chunk {
  locator: Locator;
  text: string;
  lang: string;
}

export interface ChunkOptions {
  target?: number;
  overlap?: number;
  lang?: string;
}

function unitKey(l: Locator): string {
  return `${l.page ?? ''}|${l.slide ?? ''}|${l.sheet ?? ''}`;
}

/** Fixed key order so serialised locators are stable (golden fixtures compare them). */
function locatorOf(
  unit: Locator,
  extra: { rowStart?: number; rowEnd?: number; heading?: string | undefined },
): Locator {
  const out: Locator = {};
  if (unit.page !== undefined) out.page = unit.page;
  if (unit.slide !== undefined) out.slide = unit.slide;
  if (unit.sheet !== undefined) out.sheet = unit.sheet;
  if (extra.rowStart !== undefined) out.rowStart = extra.rowStart;
  if (extra.rowEnd !== undefined) out.rowEnd = extra.rowEnd;
  if (extra.heading) out.heading = extra.heading.slice(0, 400);
  return out;
}

const WS = /\s/u;

/** Last <= `n` characters of `text`, starting at a word boundary; '' when the text is not longer than `n`. */
export function overlapTail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return '';
  let start = text.length - n;
  // Do not start inside a surrogate pair.
  const c = text.charCodeAt(start);
  if (c >= 0xdc00 && c <= 0xdfff) start += 1;
  const prev = text[start - 1];
  if (prev !== undefined && !WS.test(prev)) {
    // Mid-word: skip to the next whitespace so the tail begins on a whole word.
    let i = start;
    while (i < text.length && !WS.test(text[i] as string)) i += 1;
    start = i;
  }
  return text.slice(start).trim();
}

/** Windows of at most `target` characters, broken at whitespace, successive windows overlapping by ~`overlap`. */
export function splitLong(text: string, target: number, overlap: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + target, text.length);
    if (end < text.length) {
      let cut = -1;
      for (let i = end; i > start + Math.floor(target / 2); i -= 1) {
        if (WS.test(text[i - 1] as string)) {
          cut = i;
          break;
        }
      }
      if (cut > 0) end = cut;
      else {
        const c = text.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end -= 1; // never cut between surrogates
      }
    }
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= text.length) break;
    let next = Math.max(end - overlap, start + 1);
    // Begin the next window at a word boundary at or after `next`, but before `end`.
    const prev = text[next - 1];
    if (prev !== undefined && !WS.test(prev)) {
      let i = next;
      while (i < end && !WS.test(text[i] as string)) i += 1;
      next = i < end ? i : end;
    }
    while (next < text.length && WS.test(text[next] as string)) next += 1;
    start = next;
  }
  return out;
}

interface Open {
  paras: string[];
  /** paragraphs (not counting the carried overlap) */
  fresh: number;
  rows: { text: string; row: number }[];
}

export function chunkBlocks(blocks: readonly Block[], opts: ChunkOptions = {}): Chunk[] {
  const target = opts.target ?? CHUNK_TARGET_CHARS;
  const overlap = opts.overlap ?? CHUNK_OVERLAP_CHARS;
  const lang = opts.lang ?? 'en';
  const out: Chunk[] = [];

  let unit: Locator = {};
  let key: string | null = null;
  const headingStack: { level: number; text: string }[] = [];
  let pendingHeading: string | null = null;
  let open: Open = { paras: [], fresh: 0, rows: [] };
  let carry = '';

  const path = (): string | undefined =>
    headingStack.length ? headingStack.map((h) => h.text).join(' > ') : undefined;
  const emit = (text: string, loc: Locator) => {
    const t = wellFormed(text);
    if (t.trim()) out.push({ locator: loc, text: t, lang });
  };
  const flush = (keepCarry: boolean) => {
    if (open.rows.length > 0) {
      emit(
        open.rows.map((r) => r.text).join('\n'),
        locatorOf(unit, {
          rowStart: open.rows[0]!.row,
          rowEnd: open.rows[open.rows.length - 1]!.row,
        }),
      );
      open = { paras: [], fresh: 0, rows: [] };
      carry = '';
      return;
    }
    if (open.fresh > 0) {
      const text = open.paras.join('\n\n');
      emit(text, locatorOf(unit, { heading: path() }));
      carry = keepCarry ? overlapTail(text, overlap) : '';
    } else if (!keepCarry) carry = '';
    open = { paras: [], fresh: 0, rows: [] };
  };
  const openLen = () => open.paras.join('\n\n').length;

  const addParagraph = (p: string) => {
    if (pendingHeading !== null) {
      const h = pendingHeading;
      pendingHeading = null;
      if (h.length + 2 + p.length <= target) p = `${h}\n\n${p}`;
      else {
        // Heading alone, then the paragraph on its own.
        emit(h, locatorOf(unit, { heading: path() }));
        carry = '';
      }
    }
    if (p.length > target) {
      flush(false);
      const windows = splitLong(p, target, overlap);
      windows.forEach((w) => emit(w, locatorOf(unit, { heading: path() })));
      carry = '';
      return;
    }
    const sep = open.paras.length ? 2 : 0;
    if (open.fresh > 0 && openLen() + sep + p.length > target) {
      flush(true);
    }
    if (open.fresh === 0 && carry) {
      if (carry.length + 2 + p.length <= target) open.paras.push(carry);
      carry = '';
    }
    open.paras.push(p);
    open.fresh += 1;
  };

  const addRow = (text: string, row: number) => {
    if (open.fresh > 0 || open.paras.length > 0) flush(false);
    if (text.length > target) {
      flush(false);
      for (const w of splitLong(text, target, overlap))
        emit(w, locatorOf(unit, { rowStart: row, rowEnd: row }));
      return;
    }
    const len = open.rows.reduce((n, r, i) => n + r.text.length + (i ? 1 : 0), 0);
    if (open.rows.length > 0 && len + 1 + text.length > target) flush(false);
    open.rows.push({ text, row });
  };

  for (const b of blocks) {
    const k = unitKey(b.locator);
    if (k !== key) {
      flush(false);
      if (pendingHeading !== null) {
        emit(pendingHeading, locatorOf(unit, { heading: path() }));
        pendingHeading = null;
      }
      unit = { ...b.locator };
      delete unit.rowStart;
      delete unit.rowEnd;
      delete unit.heading;
      key = k;
      headingStack.length = 0;
      carry = '';
    }
    const text = normalizeParagraph(b.text);
    if (!text) continue;
    if (b.heading) {
      flush(false);
      if (pendingHeading !== null) {
        emit(pendingHeading, locatorOf(unit, { heading: path() }));
      }
      const level = b.level ?? 1;
      while (headingStack.length && headingStack[headingStack.length - 1]!.level >= level)
        headingStack.pop();
      headingStack.push({ level, text: text.replace(/\s+/g, ' ').slice(0, 120) });
      pendingHeading = text;
      carry = '';
      continue;
    }
    if (b.locator.rowStart !== undefined) {
      if (pendingHeading !== null) {
        emit(pendingHeading, locatorOf(unit, { heading: path() }));
        pendingHeading = null;
      }
      addRow(text, b.locator.rowStart);
    } else addParagraph(text);
  }
  flush(false);
  if (pendingHeading !== null) emit(pendingHeading, locatorOf(unit, { heading: path() }));
  return out;
}
