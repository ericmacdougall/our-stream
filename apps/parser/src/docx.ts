// SPDX-License-Identifier: AGPL-3.0-only
// DOCX via mammoth. mammoth omits tracked-change deletions and comments (the hidden-text rule); images are
// never read. The package was fully validated (sizes, DTD, paths, macros) before this runs.
import { readFile } from 'node:fs/promises';
import type { ParseLimits } from '@our-stream/documents';
import { Collector } from './collector.js';
import { Refusal } from './errors.js';
import { htmlToBlocks } from './html-text.js';

export async function extractDocx(
  path: string,
  limits: ParseLimits,
): Promise<{ collector: Collector }> {
  const mammoth = (await import('mammoth')).default;
  const buffer = await readFile(path);
  let html: string;
  try {
    const r = await mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
        ignoreEmptyParagraphs: true,
      },
    );
    html = r.value;
  } catch {
    throw new Refusal('malformed');
  }
  const collector = new Collector(limits);
  for (const b of htmlToBlocks(html.replace(/<img\b[^>]*>/gi, ''))) {
    collector.add(b.text, {}, b.heading ? { heading: true, level: b.heading } : {});
  }
  return { collector };
}
