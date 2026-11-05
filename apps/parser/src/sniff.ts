// SPDX-License-Identifier: AGPL-3.0-only
// Content sniffing: what the bytes are, independent of the declared extension and MIME type.
import { KIND_MIMES, type DocKind } from '@our-stream/documents';
import { Refusal } from './errors.js';
import { readEntry, type ValidatedPackage } from './zip.js';

export type Sniffed = 'pdf' | 'zip' | 'cfb' | 'text' | 'binary';

const BINARY_MAGIC: Buffer[] = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from('GIF8', 'latin1'),
  Buffer.from([0x1f, 0x8b]), // gzip
  Buffer.from('MZ', 'latin1'), // PE
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from('RIFF', 'latin1'),
  Buffer.from('7z\xbc\xaf', 'latin1'),
  Buffer.from('Rar!', 'latin1'),
];

export function sniff(head: Buffer): Sniffed {
  const first = head.subarray(0, 1024);
  if (first.includes(Buffer.from('%PDF-', 'latin1')) && first.indexOf('%PDF-') < 1024) return 'pdf';
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
  if (head.length >= 4 && head.readUInt32LE(0) === 0x06054b50) return 'zip';
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  )
    return 'cfb';
  for (const m of BINARY_MAGIC) if (head.subarray(0, m.length).equals(m)) return 'binary';
  return 'text';
}

const MARKUP = /^\s*(<!doctype\s+html|<html[\s>]|<svg[\s>]|<\?xml)/i;

/** Text kinds (csv, md): refuse anything that is plainly another format. */
export function assertTextLike(head: Buffer): void {
  const s = sniff(head);
  if (s !== 'text') throw new Refusal('spoofed_type');
  if (MARKUP.test(head.subarray(0, 512).toString('latin1'))) throw new Refusal('spoofed_type');
}

export function assertDeclaredMime(kind: DocKind, mime: string | null): void {
  if (mime === null) return;
  const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
  if (!KIND_MIMES[kind].includes(base)) throw new Refusal('spoofed_type');
}

const MAIN_PARTS: { kind: DocKind; part: string; type: string }[] = [
  {
    kind: 'docx',
    part: '/word/document.xml',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  },
  {
    kind: 'pptx',
    part: '/ppt/presentation.xml',
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  },
  {
    kind: 'xlsx',
    part: '/xl/workbook.xml',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  },
];
const MACRO_TYPE = /macroEnabled|vnd\.ms-office\.vbaProject/i;

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1];
}

/** Which OOXML kind a validated package is; macro-enabled and unknown packages are refused. */
export async function ooxmlKind(pkg: ValidatedPackage): Promise<DocKind> {
  const ct = await readEntry(pkg, '[Content_Types].xml');
  if (!ct) throw new Refusal('spoofed_type');
  const xml = ct.toString('utf8');
  if (MACRO_TYPE.test(xml)) throw new Refusal('macro_enabled');
  const overrides = [...xml.matchAll(/<Override\b([^>]*)>/g)].map((m) => ({
    part: attr(m[1] ?? '', 'PartName'),
    type: attr(m[1] ?? '', 'ContentType'),
  }));
  for (const m of MAIN_PARTS)
    if (overrides.some((o) => o.part === m.part && o.type === m.type)) return m.kind;
  throw new Refusal('spoofed_type');
}
