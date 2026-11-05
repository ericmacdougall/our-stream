// SPDX-License-Identifier: AGPL-3.0-only
// PDF text layer via pdfjs-dist (legacy build, no scripting, no fonts, no eval). Embedded JavaScript is never
// executed (pdfjs only runs it with enableScripting, which is off). Invisible or off-page text is extracted
// as it is: a documented limit, because it cannot be detected reliably.
import { readFile } from 'node:fs/promises';
import type { ParseLimits } from '@our-stream/documents';
import { Collector } from './collector.js';
import { Refusal } from './errors.js';

interface TextItem {
  str: string;
  hasEOL?: boolean;
  transform: number[];
  height?: number;
}

export async function extractPdf(
  path: string,
  limits: ParseLimits,
): Promise<{ collector: Collector; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(path));
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    verbosity: 0,
    stopAtErrors: false,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'PasswordException') throw new Refusal('password_protected');
    throw new Refusal('malformed');
  }
  try {
    if (doc.numPages > limits.maxPdfPages) throw new Refusal('pdf_pages');
    const collector = new Collector(limits);
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines: { text: string; y: number }[] = [];
      let cur = '';
      let y = 0;
      for (const raw of content.items) {
        const it = raw as TextItem;
        if (typeof it.str !== 'string') continue;
        if (cur === '') y = it.transform[5] ?? 0;
        cur += it.str;
        if (it.hasEOL) {
          lines.push({ text: cur, y });
          cur = '';
        }
      }
      if (cur) lines.push({ text: cur, y });
      // Paragraph break where the baseline gap is clearly larger than the page's usual line gap.
      const gaps = lines
        .slice(1)
        .map((l, i) => (lines[i] as { y: number }).y - l.y)
        .filter((g) => g > 0);
      const sorted = [...gaps].sort((a, b) => a - b);
      const typical = sorted.length ? (sorted[Math.floor(sorted.length / 2)] as number) : 0;
      let para: string[] = [];
      lines.forEach((l, i) => {
        if (i > 0 && typical > 0 && (lines[i - 1] as { y: number }).y - l.y > typical * 1.5) {
          collector.add(para.join('\n'), { page: n });
          para = [];
        }
        para.push(l.text);
      });
      collector.add(para.join('\n'), { page: n });
      page.cleanup();
    }
    return { collector, pages: doc.numPages };
  } finally {
    await task.destroy();
  }
}
