// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import type { ParseLimits } from '@our-stream/documents';
import { Collector } from './collector.js';
import { Refusal } from './errors.js';
import { decoderFor, detectEncoding } from './text-io.js';

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;

/** Markdown becomes paragraph and heading blocks; markup is left as text (the viewer never renders it). */
export async function extractMarkdown(
  path: string,
  limits: ParseLimits,
): Promise<{ collector: Collector }> {
  const { enc, skip } = await detectEncoding(path);
  const buf = await readFile(path);
  if (buf.length > limits.maxTextBytes + 3) throw new Refusal('text_too_large');
  const text = decoderFor(enc).decode(buf.subarray(skip));
  const lines = text.split(/\r\n?|\n/);
  const collector = new Collector(limits);
  let para: string[] = [];
  let fenced = false;
  const flush = () => {
    if (para.length) collector.add(para.join('\n'), {});
    para = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (FENCE.test(line)) {
      fenced = !fenced;
      para.push(line);
      continue;
    }
    if (fenced) {
      para.push(line);
      continue;
    }
    const m = ATX.exec(line);
    if (m) {
      flush();
      collector.add(m[2] ?? '', {}, { heading: true, level: (m[1] ?? '#').length });
      continue;
    }
    const next = lines[i + 1];
    if (
      line.trim() &&
      para.length === 0 &&
      next !== undefined &&
      /^ {0,3}(=+|-+)[ \t]*$/.test(next)
    ) {
      collector.add(line, {}, { heading: true, level: next.trim().startsWith('=') ? 1 : 2 });
      i += 1;
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line);
  }
  flush();
  return { collector };
}
