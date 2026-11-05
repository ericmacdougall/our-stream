// SPDX-License-Identifier: AGPL-3.0-only
// One job's extraction, run inside the sandbox's extraction thread: checks the bytes against the declared
// type, enforces the file-level limits, dispatches to the per-kind extractor and returns blocks or a refusal.
import { open, stat } from 'node:fs/promises';
import {
  EXTENSION_KIND,
  clampLimits,
  type Block,
  type DocKind,
  type JobFile,
  type ParseLimits,
  type RefusalCode,
} from '@our-stream/documents';
import { Refusal } from './errors.js';
import { extractCsv } from './csv.js';
import { extractDocx } from './docx.js';
import { extractMarkdown } from './md.js';
import { extractPdf } from './pdf.js';
import { extractPptx } from './pptx.js';
import { assertDeclaredMime, assertTextLike, ooxmlKind, sniff } from './sniff.js';
import { validateOoxml } from './zip.js';
import { extractXlsx } from './xlsx.js';

export type ExtractResult =
  { ok: true; kind: DocKind; pages?: number; blocks: Block[] } | { ok: false; code: RefusalCode };

async function readHead(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function looksEncryptedOle(path: string, size: number): Promise<boolean> {
  const needle = Buffer.from('EncryptedPackage', 'utf16le');
  const fh = await open(path, 'r');
  try {
    const step = 4 * 1024 * 1024;
    const buf = Buffer.alloc(step + needle.length);
    for (let pos = 0; pos < size; pos += step) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (buf.subarray(0, bytesRead).includes(needle)) return true;
    }
    return false;
  } finally {
    await fh.close();
  }
}

export async function extractFile(
  inputPath: string,
  job: JobFile,
  limits: ParseLimits,
): Promise<ExtractResult> {
  try {
    const st = await stat(inputPath);
    if (!st.isFile()) throw new Refusal('malformed');
    if (st.size > limits.maxFileBytes) throw new Refusal('file_too_large');
    if (st.size === 0) throw new Refusal('no_text');
    if (job.declaredExt !== null && EXTENSION_KIND[job.declaredExt.toLowerCase()] !== job.kind)
      throw new Refusal('spoofed_type');
    assertDeclaredMime(job.kind, job.declaredMime);
    const head = await readHead(inputPath, 4096);
    const s = sniff(head);
    let blocks: Block[];
    let pages: number | undefined;
    switch (job.kind) {
      case 'pdf': {
        if (s !== 'pdf') throw new Refusal('spoofed_type');
        const r = await extractPdf(inputPath, limits);
        blocks = r.collector.blocks;
        pages = r.pages;
        break;
      }
      case 'docx':
      case 'pptx':
      case 'xlsx': {
        if (s === 'cfb')
          throw new Refusal(
            (await looksEncryptedOle(inputPath, st.size)) ? 'password_protected' : 'spoofed_type',
          );
        if (s !== 'zip') throw new Refusal('spoofed_type');
        const pkg = await validateOoxml(inputPath, st.size, limits);
        if ((await ooxmlKind(pkg)) !== job.kind) throw new Refusal('spoofed_type');
        const r =
          job.kind === 'docx'
            ? await extractDocx(inputPath, limits)
            : job.kind === 'pptx'
              ? await extractPptx(pkg, limits)
              : await extractXlsx(pkg, limits);
        blocks = r.collector.blocks;
        break;
      }
      case 'csv':
      case 'md': {
        assertTextLike(head);
        const r =
          job.kind === 'csv'
            ? await extractCsv(inputPath, limits)
            : await extractMarkdown(inputPath, limits);
        blocks = r.collector.blocks;
        break;
      }
    }
    if (blocks.length === 0) throw new Refusal('no_text');
    return { ok: true, kind: job.kind, ...(pages !== undefined ? { pages } : {}), blocks };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, code: err.code };
    return { ok: false, code: 'malformed' };
  }
}

export { clampLimits };
