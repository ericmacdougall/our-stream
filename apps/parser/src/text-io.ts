// SPDX-License-Identifier: AGPL-3.0-only
// Reading text files (CSV, Markdown): BOM handling, strict UTF-8 with a windows-1252 fallback for legacy
// exports, and a raw NUL-byte refusal (UTF-16 files, which contain NULs by design, are detected by BOM first).
import { createReadStream } from 'node:fs';
import { Refusal } from './errors.js';

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export function bomOf(head: Buffer): { enc: TextEncoding | null; skip: number } {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)
    return { enc: 'utf-8', skip: 3 };
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { enc: 'utf-16le', skip: 2 };
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { enc: 'utf-16be', skip: 2 };
  return { enc: null, skip: 0 };
}

/** Decides the encoding with one streamed pass: BOM, else strict UTF-8, else windows-1252. Refuses NUL bytes. */
export async function detectEncoding(path: string): Promise<{ enc: TextEncoding; skip: number }> {
  let head: Buffer | null = null;
  let utf8 = true;
  let bom: { enc: TextEncoding | null; skip: number } = { enc: null, skip: 0 };
  const dec = new TextDecoder('utf-8', { fatal: true });
  for await (const raw of createReadStream(path)) {
    const chunk = raw as Buffer;
    if (head === null) {
      head = chunk;
      bom = bomOf(chunk);
    }
    if (bom.enc === null || bom.enc === 'utf-8') {
      if (chunk.includes(0)) throw new Refusal('nul_bytes');
      if (utf8) {
        try {
          dec.decode(chunk, { stream: true });
        } catch {
          utf8 = false;
        }
      }
    }
  }
  if (bom.enc) return { enc: bom.enc, skip: bom.skip };
  return { enc: utf8 ? 'utf-8' : 'windows-1252', skip: 0 };
}

export function decoderFor(enc: TextEncoding): InstanceType<typeof TextDecoder> {
  return new TextDecoder(enc === 'utf-16be' ? 'utf-16be' : enc);
}
