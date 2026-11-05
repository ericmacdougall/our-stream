// SPDX-License-Identifier: AGPL-3.0-only
// PPTX via officeparser. Hidden slides and speaker notes must not reach the index, and officeparser does not
// skip hidden slides, so the package handed to it is a sanitised copy: media and embeddings dropped, notes
// parts dropped, and the XML of every hidden slide (show="0") replaced by an empty slide. The result does not
// depend on how the library numbers slides.
import type { ParseLimits } from '@our-stream/documents';
import { Collector } from './collector.js';
import { Refusal } from './errors.js';
import { readEntry, type ValidatedPackage } from './zip.js';
import { writeZip } from './zip-write.js';

const EMPTY_SLIDE =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>';
const SKIP =
  /^(ppt\/(media|embeddings|notesSlides|notesMasters|handoutMasters|activeX|ink)\/|customXml\/|docProps\/thumbnail)/i;
const TEXT_PART_MAX = 16 * 1024 * 1024;

interface OfficeNode {
  type: string;
  text?: string;
  children?: OfficeNode[];
  metadata?: { slideNumber?: number };
}

export async function sanitizePptx(pkg: ValidatedPackage): Promise<Buffer> {
  const hidden = new Set<string>();
  for (const e of pkg.entries) {
    if (!/^ppt\/slides\/[^/]+\.xml$/i.test(e.name)) continue;
    const xml = (await readEntry(pkg, e.name, TEXT_PART_MAX))?.toString('utf8') ?? '';
    const root = /<p:sld\b[^>]*>/.exec(xml)?.[0] ?? '';
    if (/\bshow\s*=\s*"(0|false)"/i.test(root)) hidden.add(e.name);
  }
  const parts: { name: string; data: Buffer }[] = [];
  let total = 0;
  for (const e of pkg.entries) {
    if (e.name.endsWith('/') || SKIP.test(e.name)) continue;
    if (e.size > TEXT_PART_MAX && !/\.(xml|rels)$/i.test(e.name)) continue; // never ship large binaries
    const data = hidden.has(e.name)
      ? Buffer.from(EMPTY_SLIDE)
      : await readEntry(pkg, e.name, TEXT_PART_MAX);
    if (!data) continue;
    total += data.length;
    if (total > 256 * 1024 * 1024) throw new Refusal('text_too_large');
    // Slide rels pointing at the removed notes part would dangle; strip those relationships.
    parts.push({
      name: e.name,
      data: /^ppt\/slides\/_rels\//i.test(e.name)
        ? Buffer.from(data.toString('utf8').replace(/<Relationship\b[^>]*notesSlide[^>]*\/>/gi, ''))
        : data,
    });
  }
  return writeZip(parts);
}

function collectText(node: OfficeNode, out: string[]): void {
  if (node.type === 'note') return;
  if ((node.type === 'paragraph' || node.type === 'heading') && typeof node.text === 'string') {
    out.push(node.text);
    return;
  }
  if (node.type === 'row') {
    const cells: string[] = [];
    for (const c of node.children ?? []) {
      const t: string[] = [];
      collectText(c, t);
      if (t.length) cells.push(t.join(' '));
    }
    if (cells.length) out.push(cells.join(' | '));
    return;
  }
  for (const c of node.children ?? []) collectText(c, out);
}

export async function extractPptx(
  pkg: ValidatedPackage,
  limits: ParseLimits,
): Promise<{ collector: Collector }> {
  const { OfficeParser } = await import('officeparser');
  const buffer = await sanitizePptx(pkg);
  let ast;
  try {
    ast = await OfficeParser.parseOffice(buffer, { ignoreNotes: true, ocr: false } as never);
  } catch {
    throw new Refusal('malformed');
  }
  const collector = new Collector(limits);
  (ast.content as unknown as OfficeNode[]).forEach((slide, i) => {
    if (slide.type !== 'slide') return;
    const texts: string[] = [];
    for (const c of slide.children ?? []) collectText(c, texts);
    const n = slide.metadata?.slideNumber ?? i + 1;
    for (const t of texts) collector.add(t, { slide: n });
  });
  return { collector };
}
