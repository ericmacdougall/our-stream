// SPDX-License-Identifier: AGPL-3.0-only
// Fixture helpers shared by the unit and runtime suites: real (not forged) bombs written as streams, and
// the one-fixture-per-case table of NEG-1.
import { createWriteStream } from 'node:fs';
import { createDeflateRaw, crc32 } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { docx } from './builders.js';

/** A real DOCX-shaped zip whose single big entry inflates to `bytes` of zeros (compresses ~1000:1). */
export async function writeZeroBomb(
  path: string,
  bytes: number,
  opts: { lieAboutSize?: number } = {},
): Promise<void> {
  const name = Buffer.from('word/bomb.xml');
  const zeros = Buffer.alloc(1024 * 1024);
  let remaining = bytes;
  let crc = 0;
  const src = Readable.from(
    (async function* () {
      while (remaining > 0) {
        const n = Math.min(remaining, zeros.length);
        const chunk = n === zeros.length ? zeros : zeros.subarray(0, n);
        crc = crc32(chunk, crc);
        remaining -= n;
        yield chunk;
      }
    })(),
  );
  const deflate = createDeflateRaw({ level: 1 });
  const chunks: Buffer[] = [];
  let compSize = 0;
  deflate.on('data', (c: Buffer) => {
    compSize += c.length;
    chunks.push(c);
  });
  const ended = new Promise<void>((resolve) => deflate.once('end', () => resolve()));
  await pipeline(src, deflate);
  await ended;
  const body = Buffer.concat(chunks);
  const declared = opts.lieAboutSize ?? bytes;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(compSize, 18);
  lh.writeUInt32LE(declared, 22);
  lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(compSize, 20);
  ch.writeUInt32LE(declared, 24);
  ch.writeUInt16LE(name.length, 28);
  const cdOffset = 30 + name.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  const out = createWriteStream(path);
  await pipeline(Readable.from([lh, name, body, ch, name, end]), out);
}

/** A worksheet XML with `cells` numeric cells, written as one string of rows of 100 cells. */
export function bigSheetXml(cells: number): string {
  const rows: string[] = [];
  for (let r = 0, left = cells; left > 0; r += 1) {
    const n = Math.min(100, left);
    left -= n;
    const cs: string[] = [];
    for (let c = 0; c < n; c += 1)
      cs.push(`<c r="${String.fromCharCode(65 + (c % 26))}${r + 1}"><v>1</v></c>`);
    rows.push(`<row r="${r + 1}">${cs.join('')}</row>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

export const XXE_DOCTYPE =
  '<?xml version="1.0"?>\n<!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n';

export function xxeDocx(): Buffer {
  return docx([{ text: 'before &xxe; after' }], { documentXmlPrefix: XXE_DOCTYPE });
}
