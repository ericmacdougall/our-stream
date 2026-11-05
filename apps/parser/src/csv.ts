// SPDX-License-Identifier: AGPL-3.0-only
// Streaming CSV: one block per record with a row locator; records may span lines when quoted. A physical
// line over the limit is refused while streaming, before it is assembled in memory.
import { createReadStream } from 'node:fs';
import type { ParseLimits } from '@our-stream/documents';
import { Collector } from './collector.js';
import { Refusal } from './errors.js';
import { decoderFor, detectEncoding } from './text-io.js';

function detectDelimiter(sample: string): string {
  const first = sample.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let bestN = 0;
  for (const d of [',', ';', '\t', '|']) {
    let n = 0;
    let q = false;
    for (const ch of first) {
      if (ch === '"') q = !q;
      else if (ch === d && !q) n += 1;
    }
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

export async function extractCsv(
  path: string,
  limits: ParseLimits,
): Promise<{ collector: Collector }> {
  const { enc, skip } = await detectEncoding(path);
  const collector = new Collector(limits);
  const dec = decoderFor(enc);
  let delim: string | null = null;
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let record = 0;
  let lineBytes = 0;
  let pendingQuote = false; // saw a quote inside quotes; next char decides escape or close
  let first = true;

  const endRecord = () => {
    row.push(field);
    field = '';
    record += 1;
    const cells = row.map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length > 0) collector.add(cells.join(' | '), { rowStart: record, rowEnd: record });
    row = [];
  };

  const feed = (text: string) => {
    if (delim === null) delim = detectDelimiter(text);
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i] as string;
      if (ch === '\n') {
        lineBytes = 0;
      } else {
        // Bytes per char: one for ASCII, up to three for BMP, a surrogate half counts two (4 per pair).
        lineBytes += ch.charCodeAt(0) < 0x80 ? 1 : ch.charCodeAt(0) < 0x800 ? 2 : 3;
        if (lineBytes > limits.maxCsvLineBytes) throw new Refusal('csv_line');
      }
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') {
          field += '"';
          continue;
        }
        inQuotes = false;
      }
      if (inQuotes) {
        if (ch === '"') pendingQuote = true;
        else field += ch;
        continue;
      }
      if (ch === '"' && field.length === 0) inQuotes = true;
      else if (ch === delim) {
        row.push(field);
        field = '';
      } else if (ch === '\n') endRecord();
      else if (ch === '\r') continue;
      else field += ch;
    }
  };

  for await (const raw of createReadStream(path)) {
    let chunk = raw as Buffer;
    if (first) {
      first = false;
      chunk = chunk.subarray(skip);
    }
    feed(dec.decode(chunk, { stream: true }));
  }
  feed(dec.decode());
  if (pendingQuote) inQuotes = false;
  if (field.length > 0 || row.length > 0) endRecord();
  return { collector };
}
