// SPDX-License-Identifier: AGPL-3.0-only
// Turns the narrow HTML that mammoth emits (headings, paragraphs, lists, tables, inline formatting) into
// blocks. Not a general HTML parser; input is a library's output for a validated package, never the upload.
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp)
        : '�';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export interface HtmlBlock {
  text: string;
  heading?: number;
}

export function htmlToBlocks(html: string): HtmlBlock[] {
  const out: HtmlBlock[] = [];
  const re = /<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>|([^<]+)/gi;
  let buf = '';
  let heading = 0;
  let cell: string[] | null = null;
  let row: string[] | null = null;
  const flush = () => {
    const t = decodeEntities(buf).trim();
    buf = '';
    if (!t) return;
    if (cell) cell.push(t);
    else out.push(heading ? { text: t, heading } : { text: t });
  };
  for (const m of html.matchAll(re)) {
    if (m[4] !== undefined) {
      buf += m[4];
      continue;
    }
    const closing = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      if (closing) {
        flush();
        heading = 0;
      } else {
        flush();
        heading = Number(tag[1]);
      }
    } else if (tag === 'p' || tag === 'li') {
      flush();
    } else if (tag === 'br') {
      buf += '\n';
    } else if (tag === 'tr') {
      if (closing) {
        flush();
        if (row && row.length) out.push({ text: row.join(' | ') });
        row = null;
      } else row = [];
    } else if (tag === 'td' || tag === 'th') {
      if (closing) {
        flush();
        if (cell && row) row.push(cell.join(' '));
        cell = null;
      } else {
        flush();
        cell = [];
      }
    }
  }
  flush();
  return out;
}
