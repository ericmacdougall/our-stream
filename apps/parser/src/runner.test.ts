// SPDX-License-Identifier: AGPL-3.0-only
// The thread runner and the file-protocol service, against the built extraction thread (`pnpm test` builds
// first). Wall-clock and heap budgets end a job as a refusal while the service stays up for the next job.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, ResultFileSchema, type JobFile } from '@our-stream/documents';
import { docx, pdf } from './testing/builders.js';
import { runExtraction } from './runner.js';
import { ParserService } from './service.js';

const entry = new URL('../dist/extract-thread.js', import.meta.url);
let dir = '';
const job = (kind: JobFile['kind'] = 'docx'): JobFile => ({
  v: 1,
  jobId: 'c'.repeat(32),
  kind,
  declaredMime: null,
  declaredExt: kind,
});

beforeAll(async () => {
  expect(existsSync(entry), 'run `pnpm build` first (pnpm test does)').toBe(true);
  dir = await mkdtemp(join(tmpdir(), 'parser-runner-'));
});
afterAll(() => undefined);

describe('runExtraction (worker thread)', () => {
  it('control: a real document is parsed in the thread', async () => {
    const p = join(dir, 'ok.docx');
    await writeFile(p, docx([{ text: 'Hello', style: 'Heading1' }, { text: 'World' }]));
    const r = await runExtraction(p, job(), DEFAULT_LIMITS, entry);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.blocks.map((b) => b.text)).toEqual(['Hello', 'World']);
  });

  it('wall budget: a job past its wall clock is a wall_time refusal', async () => {
    const p = join(dir, 'wall.pdf');
    await writeFile(
      p,
      pdf(Array.from({ length: 400 }, (_, i) => [`page ${i}`, 'text '.repeat(40)])),
    );
    const r = await runExtraction(p, job('pdf'), { ...DEFAULT_LIMITS, wallMs: 5 }, entry);
    expect(r).toEqual({ ok: false, code: 'wall_time' });
    const control = await runExtraction(p, job('pdf'), DEFAULT_LIMITS, entry);
    expect(control.ok).toBe(true);
  });

  it('memory budget: exceeding the heap cap is a memory refusal, the process survives', async () => {
    const p = join(dir, 'mem.docx');
    const paras = Array.from({ length: 60_000 }, (_, i) => ({
      text: `paragraph number ${i} with some padding text to take memory`,
    }));
    await writeFile(p, docx(paras));
    const r = await runExtraction(p, job(), { ...DEFAULT_LIMITS, heapMb: 24 }, entry);
    expect(r).toEqual({ ok: false, code: 'memory' });
    const control = await runExtraction(p, job(), DEFAULT_LIMITS, entry);
    expect(control.ok).toBe(true);
  });
});

describe('ParserService file protocol', () => {
  it('runs one job at a time from the single slot and writes a schema-valid result', async () => {
    const slot = join(dir, 'slot');
    const ctl = join(dir, 'ctl');
    await mkdir(slot, { recursive: true });
    await mkdir(ctl, { recursive: true });
    const svc = new ParserService({
      slotDir: slot,
      ctlDir: ctl,
      pollMs: 20,
      heartbeatMs: 50,
      inProcess: true,
      selfTest: async () => ({
        ok: true,
        network: 'blocked',
        rootfs: 'readonly',
        nonRoot: true,
        noSecretEnv: true,
      }),
    });
    await svc.start();
    try {
      const src = join(dir, 'proto.docx');
      await writeFile(src, docx([{ text: 'Protocol text' }]));
      await copyFile(src, join(slot, 'input.bin'));
      await writeFile(join(slot, 'job.json'), JSON.stringify(job()));
      const resultPath = join(slot, 'result.json');
      for (let i = 0; i < 200 && !existsSync(resultPath); i += 1)
        await new Promise((r) => setTimeout(r, 25));
      const parsed = ResultFileSchema.parse(JSON.parse(await readFile(resultPath, 'utf8')));
      expect(parsed.ok).toBe(true);
      expect(svc.maxConcurrent).toBe(1);
      // The same occupant is never run twice: result stays until the worker wipes the slot.
      await new Promise((r) => setTimeout(r, 100));
      expect(ResultFileSchema.parse(JSON.parse(await readFile(resultPath, 'utf8')))).toEqual(
        parsed,
      );
      // Wiped slot, new job id: runs again.
      await unlink(resultPath);
      await unlink(join(slot, 'job.json'));
      await new Promise((r) => setTimeout(r, 60));
      await writeFile(join(slot, 'job.json'), JSON.stringify({ ...job(), jobId: 'd'.repeat(32) }));
      for (let i = 0; i < 200 && !existsSync(resultPath); i += 1)
        await new Promise((r) => setTimeout(r, 25));
      expect(ResultFileSchema.parse(JSON.parse(await readFile(resultPath, 'utf8'))).jobId).toBe(
        'd'.repeat(32),
      );
    } finally {
      svc.stop();
    }
  });

  it('answers a challenge with its start nonce and ignores malformed or mismatched challenge files', async () => {
    const slot = join(dir, 'slot2');
    const ctl = join(dir, 'ctl2');
    await mkdir(slot, { recursive: true });
    await mkdir(ctl, { recursive: true });
    const svc = new ParserService({
      slotDir: slot,
      ctlDir: ctl,
      pollMs: 20,
      heartbeatMs: 50,
      inProcess: true,
      selfTest: async () => ({
        ok: true,
        network: 'blocked',
        rootfs: 'readonly',
        nonRoot: true,
        noSecretEnv: true,
      }),
    });
    await svc.start();
    try {
      const id = 'e'.repeat(32);
      await writeFile(
        join(ctl, `challenge-${id}.json`),
        JSON.stringify({ v: 1, id: 'f'.repeat(32) }),
      ); // name/id mismatch
      await writeFile(join(ctl, `challenge-${'1'.repeat(32)}.json`), 'not json');
      await writeFile(
        join(ctl, `challenge-${'2'.repeat(32)}.json`),
        JSON.stringify({ v: 1, id: '2'.repeat(32) }),
      );
      const resp = join(ctl, `response-${'2'.repeat(32)}.json`);
      for (let i = 0; i < 200 && !existsSync(resp); i += 1)
        await new Promise((r) => setTimeout(r, 25));
      expect(JSON.parse(await readFile(resp, 'utf8'))).toMatchObject({
        id: '2'.repeat(32),
        nonce: svc.nonce,
        selfTestOk: true,
      });
      expect(existsSync(join(ctl, `response-${id}.json`))).toBe(false);
      expect(existsSync(join(ctl, `response-${'1'.repeat(32)}.json`))).toBe(false);
    } finally {
      svc.stop();
    }
  });
});
