// SPDX-License-Identifier: AGPL-3.0-only
// Minimal, defensive ZIP reader for OOXML packages. It never extracts to disk. Before any library sees the
// package, every entry is inflated once into a counter, so a forged central directory (a small declared size
// over a bomb) is caught by the actual byte count, not by the header. Checks: encrypted entries, zip64 and
// oversize, entry names that escape the package (`../`, absolute, drive letters, backslashes, NUL), total
// uncompressed size and ratio, and DTD/entity declarations or UTF-16/32 encoding in any XML part.
import { createReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';
import type { ParseLimits } from '@our-stream/documents';
import { Refusal } from './errors.js';

export interface ZipEntryInfo {
  name: string;
  flags: number;
  method: number;
  compSize: number;
  size: number;
  offset: number;
}

const U32_MAX = 0xffffffff;
const MAX_ENTRIES = 10_000;
const MAX_CENTRAL_DIR = 16 * 1024 * 1024;

export function unsafeEntryName(name: string): boolean {
  if (name.length === 0 || name.includes('\u0000') || name.includes('\\')) return true;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true;
  return name.split('/').some((seg) => seg === '..');
}

export async function readZipDirectory(
  path: string,
  fileSize: number,
  limits: ParseLimits,
): Promise<ZipEntryInfo[]> {
  const fh = await open(path, 'r');
  try {
    const tailLen = Math.min(fileSize, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, fileSize - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Refusal('malformed');
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdSize === U32_MAX || cdOffset === U32_MAX)
      throw new Refusal('ooxml_too_large'); // zip64
    if (total > MAX_ENTRIES || cdSize > MAX_CENTRAL_DIR) throw new Refusal('malformed');
    if (cdOffset + cdSize > fileSize) throw new Refusal('malformed');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntryInfo[] = [];
    let p = 0;
    let sum = 0;
    for (let i = 0; i < total; i += 1) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Refusal('malformed');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen > cd.length) throw new Refusal('malformed');
      const raw = cd.subarray(p + 46, p + 46 + nameLen);
      const name = (flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1')).normalize('NFC');
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & 0x1 || flags & 0x40) throw new Refusal('password_protected');
      if (compSize === U32_MAX || size === U32_MAX || offset === U32_MAX)
        throw new Refusal('ooxml_too_large');
      if (unsafeEntryName(name)) throw new Refusal('unsafe_path');
      if (!name.endsWith('/')) {
        if (method !== 0 && method !== 8) throw new Refusal('malformed');
        sum += size;
        if (sum > limits.maxOoxmlUncompressedBytes) throw new Refusal('ooxml_too_large');
        if (size > 1024 * 1024 && size / Math.max(compSize, 1) > limits.maxOoxmlRatio)
          throw new Refusal('ooxml_ratio');
      }
      entries.push({ name, flags, method, compSize, size, offset });
    }
    if (sum / Math.max(fileSize, 1) > limits.maxOoxmlRatio) throw new Refusal('ooxml_ratio');
    return entries;
  } finally {
    await fh.close();
  }
}

async function dataStart(fh: FileHandle, e: ZipEntryInfo, fileSize: number): Promise<number> {
  const head = Buffer.alloc(30);
  await fh.read(head, 0, 30, e.offset);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Refusal('malformed');
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  if (start + e.compSize > fileSize) throw new Refusal('malformed');
  return start;
}

const isXmlPart = (name: string) => /\.(xml|rels)$/i.test(name);
const DTD = /<!(DOCTYPE|ENTITY)/i;

/**
 * Inflates one entry through `onChunk`, enforcing that the real size equals the declared size and never
 * exceeds `cap` (the remaining package budget).
 */
async function streamEntry(
  path: string,
  fh: FileHandle,
  fileSize: number,
  e: ZipEntryInfo,
  cap: number,
  onChunk: (c: Buffer) => void,
): Promise<number> {
  const start = await dataStart(fh, e, fileSize);
  if (e.compSize === 0) {
    if (e.size !== 0) throw new Refusal('malformed');
    return 0;
  }
  const src = createReadStream(path, { start, end: start + e.compSize - 1 });
  let count = 0;
  const consume = (c: Buffer) => {
    count += c.length;
    if (count > e.size || count > cap) {
      src.destroy();
      throw new Refusal(count > cap ? 'ooxml_too_large' : 'malformed');
    }
    onChunk(c);
  };
  try {
    if (e.method === 0) {
      for await (const c of src) consume(c as Buffer);
    } else {
      const inflate = createInflateRaw();
      src.pipe(inflate);
      src.on('error', (err) => inflate.destroy(err));
      for await (const c of inflate) consume(c as Buffer);
    }
  } catch (err) {
    if (err instanceof Refusal) throw err;
    throw new Refusal('malformed');
  } finally {
    src.destroy();
  }
  if (count !== e.size) throw new Refusal('malformed');
  return count;
}

export interface ValidatedPackage {
  entries: ZipEntryInfo[];
  fileSize: number;
  path: string;
}

/** Full pre-validation pass; throws Refusal. */
export async function validateOoxml(
  path: string,
  fileSize: number,
  limits: ParseLimits,
): Promise<ValidatedPackage> {
  const entries = await readZipDirectory(path, fileSize, limits);
  const fh = await open(path, 'r');
  try {
    let budget = limits.maxOoxmlUncompressedBytes;
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      if (/(^|\/)vbaProject\.bin$/i.test(e.name) || /(^|\/)vbaData\.xml$/i.test(e.name))
        throw new Refusal('macro_enabled');
      const xml = isXmlPart(e.name);
      let carry = '';
      let first = true;
      const used = await streamEntry(path, fh, fileSize, e, budget, (c) => {
        if (!xml) return;
        if (first) {
          first = false;
          const b0 = c[0];
          const b1 = c[1];
          // UTF-16/32 BOMs: the DTD scan below is byte-ASCII, so refuse encodings that would hide a DTD.
          if (
            (b0 === 0xff && b1 === 0xfe) ||
            (b0 === 0xfe && b1 === 0xff) ||
            (b0 === 0x3c && b1 === 0x00) ||
            (b0 === 0x00 && b1 === 0x3c)
          )
            throw new Refusal('xml_dtd');
        }
        const text = carry + c.toString('latin1');
        if (DTD.test(text)) throw new Refusal('xml_dtd');
        carry = text.slice(-16);
      });
      budget -= used;
    }
  } finally {
    await fh.close();
  }
  return { entries, fileSize, path };
}

/** Reads one small entry fully (bounded by `maxBytes`), re-checking the real size. */
export async function readEntry(
  pkg: ValidatedPackage,
  name: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<Buffer | null> {
  const e = pkg.entries.find((x) => x.name === name);
  if (!e) return null;
  if (e.size > maxBytes) throw new Refusal('malformed');
  const fh = await open(pkg.path, 'r');
  try {
    const parts: Buffer[] = [];
    await streamEntry(pkg.path, fh, pkg.fileSize, e, maxBytes, (c) => parts.push(Buffer.from(c)));
    return Buffer.concat(parts);
  } finally {
    await fh.close();
  }
}

export function entryNames(pkg: ValidatedPackage): string[] {
  return pkg.entries.map((e) => e.name);
}

export const _internal = { isXmlPart };
