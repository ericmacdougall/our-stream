// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers for the document routes of the mock API: the upload allow-list (mirrors
// apps/api/src/lib/documents.ts), a deterministic stand-in for the parser, section grouping and keyword
// matching. A test double, not the real parser: the bytes are never really parsed; the format decides the
// anchors and a NOTEXT marker in the bytes makes the parse fail with `no_text`.

export const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
const OOXML = 'application/vnd.openxmlformats-officedocument';
export const FORMATS = {
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
const LEGACY = new Set(['doc', 'ppt', 'xls']);
const CANONICAL_TYPE = Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [k, v.mimes[0]]));

export function sanitizeName(raw) {
  let name = String(raw)
    .normalize('NFC')
    .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/[\p{Cc}/\\:*?"<>|]/gu, '_');
  name = name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  return name.slice(0, 200);
}

/** { ok: true, format, fileName } or { ok: false, message } for a declared name and MIME type. */
export function checkUpload(rawName, mimeType) {
  const fileName = sanitizeName(rawName);
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : null;
  if (!ext) return { ok: false, message: 'the file needs one of the supported extensions' };
  if (LEGACY.has(ext))
    return { ok: false, message: 'legacy .doc, .ppt and .xls files are not supported' };
  const format = Object.keys(FORMATS).find((f) => FORMATS[f].exts.includes(ext));
  if (!format)
    return { ok: false, message: 'supported documents: PDF, DOCX, PPTX, XLSX, CSV and Markdown' };
  if (!FORMATS[format].mimes.includes(String(mimeType).toLowerCase()))
    return { ok: false, message: `the declared type does not match a .${ext} file` };
  return { ok: true, format, fileName };
}

export function formatOfName(fileName) {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  return Object.keys(FORMATS).find((f) => FORMATS[f].exts.includes(ext)) ?? null;
}
export const canonicalType = (format) => CANONICAL_TYPE[format];

const anchor = (label, extra = {}) => ({
  label,
  page: null,
  slide: null,
  sheet: null,
  rowStart: null,
  rowEnd: null,
  heading: null,
  ...extra,
});

/** Chunks `{ anchor, text }` for the bytes, or [] (the parse then fails with `no_text`). */
export function mockParse(format, bytes, fileName) {
  const text = bytes.toString('utf8');
  if (text.includes('NOTEXT')) return [];
  const stem = fileName.replace(/\.[^.]+$/, '');
  switch (format) {
    case 'pdf':
      return [1, 2, 3].map((n) => ({
        anchor: anchor(`Page ${n}`, { page: n }),
        text: `${stem} page ${n}. The quarterly budget review covers hiring, travel and tooling.`,
      }));
    case 'pptx':
      return [1, 2].map((n) => ({
        anchor: anchor(`Slide ${n}`, { slide: n }),
        text: `${stem} slide ${n}. Roadmap milestones for the quarterly budget.`,
      }));
    case 'docx':
      return ['Overview', 'Budget'].map((h) => ({
        anchor: anchor(h, { heading: h }),
        text: `${stem} ${h.toLowerCase()} section. The quarterly budget is owned by finance.`,
      }));
    case 'xlsx':
      return [
        {
          anchor: anchor('Budget rows 1-2', { sheet: 'Budget', rowStart: 1, rowEnd: 2 }),
          text: `${stem} sheet Budget: travel 1200, tooling 800 (quarterly budget)`,
        },
        {
          anchor: anchor('Budget rows 3-4', { sheet: 'Budget', rowStart: 3, rowEnd: 4 }),
          text: `${stem} sheet Budget: hiring 9000, events 300`,
        },
      ];
    case 'csv': {
      const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '');
      const out = [];
      for (let i = 0; i < rows.length; i += 2) {
        const end = Math.min(i + 2, rows.length);
        out.push({
          anchor: anchor(`Rows ${i + 1}-${end}`, { rowStart: i + 1, rowEnd: end }),
          text: rows.slice(i, end).join('\n'),
        });
      }
      return out;
    }
    case 'md': {
      const out = [];
      let heading = null;
      let buf = [];
      const flush = () => {
        const body = buf.join('\n').trim();
        if (body || heading) {
          out.push({
            anchor: heading ? anchor(heading, { heading }) : anchor('Text'),
            text: [heading, body].filter(Boolean).join('\n'),
          });
        }
        buf = [];
      };
      for (const line of text.split(/\r?\n/)) {
        const m = /^#{1,6}\s+(.*)$/.exec(line);
        if (m) {
          flush();
          heading = m[1].trim();
        } else buf.push(line);
      }
      flush();
      return out.filter((c) => c.text.trim() !== '');
    }
    default:
      return [];
  }
}

const sameAnchor = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Consecutive chunks with the same anchor grouped into sections. */
export function sectionize(chunks) {
  const sections = [];
  for (const c of chunks) {
    const last = sections[sections.length - 1];
    if (last && sameAnchor(last.anchor, c.anchor))
      last.chunks.push({ ordinal: c.ordinal, text: c.text });
    else sections.push({ anchor: c.anchor, chunks: [{ ordinal: c.ordinal, text: c.text }] });
  }
  return sections;
}

export function tokens(q) {
  return [
    ...new Set(
      String(q)
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 0),
    ),
  ];
}

/** UTF-16 `[start, end)` ranges of every token occurrence in text, ascending and non-overlapping. */
export function rangesFor(text, toks) {
  const lower = text.toLowerCase();
  const found = [];
  for (const tok of toks) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(tok, from);
      if (at < 0) break;
      found.push([at, at + tok.length]);
      from = at + tok.length;
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out = [];
  for (const r of found) {
    const prev = out[out.length - 1];
    if (!prev || r[0] >= prev[1]) out.push(r);
  }
  return out;
}
