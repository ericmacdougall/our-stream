// SPDX-License-Identifier: AGPL-3.0-only
// XLSX via exceljs' streaming reader. Hidden and very hidden sheets are skipped. Formulas are never
// evaluated and their text is never emitted; only a plain cached result is. External links are never
// followed (exceljs does not, and the sandbox has no network). Cells are counted as they stream.
import type { ParseLimits } from '@our-stream/documents';
import { Collector } from './collector.js';
import { Refusal } from './errors.js';
import { readEntry, type ValidatedPackage } from './zip.js';

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) return cellText(o['result']); // cached result only
    if (Array.isArray(o['richText']))
      return (o['richText'] as { text?: string }[]).map((r) => r.text ?? '').join('');
    if (typeof o['text'] === 'string') return o['text']; // hyperlink display text, never the target
    if ('error' in o) return '';
  }
  return '';
}

const unescapeXml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Sheet names from workbook.xml: all of them, and the hidden / very hidden subset. */
export async function sheetNames(
  pkg: ValidatedPackage,
): Promise<{ all: Set<string>; hidden: Set<string> }> {
  const wb = (await readEntry(pkg, 'xl/workbook.xml'))?.toString('utf8') ?? '';
  const all = new Set<string>();
  const hidden = new Set<string>();
  for (const m of wb.matchAll(/<sheet\b([^>]*)>/g)) {
    const attrs = m[1] ?? '';
    const state = /\bstate\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    const raw = /\bname\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (!raw) continue;
    const name = unescapeXml(raw);
    all.add(name);
    if (state === 'hidden' || state === 'veryHidden') hidden.add(name);
  }
  return { all, hidden };
}

export async function extractXlsx(
  pkg: ValidatedPackage,
  limits: ParseLimits,
): Promise<{ collector: Collector }> {
  const ExcelJS = (await import('exceljs')).default;
  const { all, hidden } = await sheetNames(pkg);
  const seen = new Set<string>();
  const collector = new Collector(limits);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(pkg.path, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
    entries: 'ignore',
  });
  let cells = 0;
  try {
    for await (const ws of reader) {
      const sheet = ws as unknown as AsyncIterable<{ number: number; values: unknown[] }> & {
        name: string;
      };
      seen.add(sheet.name);
      const skip = hidden.has(sheet.name);
      for await (const row of sheet) {
        if (skip) continue;
        const parts: string[] = [];
        const values = row.values as unknown[];
        for (let i = 1; i < values.length; i += 1) {
          const v = values[i];
          if (v === null || v === undefined || v === '') continue;
          cells += 1;
          if (cells > limits.maxXlsxCells) throw new Refusal('cell_limit');
          const t = cellText(v).trim();
          if (t) parts.push(t);
        }
        if (parts.length)
          collector.add(parts.join(' | '), {
            sheet: sheet.name.slice(0, 200),
            rowStart: row.number,
            rowEnd: row.number,
          });
      }
    }
  } catch (err) {
    if (err instanceof Refusal) throw err;
    throw new Refusal('malformed');
  }
  // The streaming reader drops sheets silently when the package does not list shared strings before its
  // worksheets; indexing only some of a workbook would be a partial result, so refuse instead.
  for (const name of all) if (!seen.has(name)) throw new Refusal('malformed');
  return { collector };
}
