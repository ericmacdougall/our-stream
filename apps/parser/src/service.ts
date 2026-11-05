// SPDX-License-Identifier: AGPL-3.0-only
// The parser service loop: heartbeat + challenge responder on the control directory, and a one-job-at-a-time
// poller on the single job slot. No sockets, no HTTP: everything is files, so the container can run with
// `network_mode: none` and a deny-all NetworkPolicy.
import { randomBytes } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ChallengeSchema,
  JobFileSchema,
  clampLimits,
  type Heartbeat,
  type ResultFile,
} from '@our-stream/documents';
import { extractFile, type ExtractResult } from './extract.js';
import { readRegularFile, writeAtomic } from './fsutil.js';
import { runExtraction } from './runner.js';
import { runSelfTest } from './selftest.js';

export interface ParserServiceOptions {
  slotDir: string;
  ctlDir: string;
  heartbeatMs?: number;
  pollMs?: number;
  /** Test seam: run extraction in-process instead of in a thread. */
  inProcess?: boolean;
  /** Test seam: replace the self-test (unit tests run outside a container). */
  selfTest?: () => Promise<Heartbeat['selfTest']>;
  log?: (o: object, msg: string) => void;
}

const ZERO_ID = '0'.repeat(32);

export class ParserService {
  readonly nonce = randomBytes(16).toString('hex');
  private readonly startedAt = new Date().toISOString();
  private selfTest: Heartbeat['selfTest'] | null = null;
  private timers: NodeJS.Timeout[] = [];
  private busy = false;
  private stopped = false;
  private lastJobId = '';
  /** Jobs run since start (the one-at-a-time invariant is asserted in tests). */
  maxConcurrent = 0;
  private running = 0;

  constructor(private readonly o: ParserServiceOptions) {}

  private get log() {
    return this.o.log ?? (() => undefined);
  }

  async start(): Promise<void> {
    this.selfTest = await (this.o.selfTest ?? runSelfTest)();
    this.log({ selfTest: this.selfTest }, 'parser self-test');
    await this.beat();
    this.timers.push(
      setInterval(() => void this.beat().catch(() => undefined), this.o.heartbeatMs ?? 2000),
    );
    const poll = this.o.pollMs ?? 200;
    this.timers.push(setInterval(() => void this.answerChallenges().catch(() => undefined), poll));
    this.timers.push(setInterval(() => void this.pollSlot().catch(() => undefined), poll));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private async beat(): Promise<void> {
    if (!this.selfTest || this.stopped) return;
    const hb: Heartbeat = {
      v: 1,
      nonce: this.nonce,
      startedAt: this.startedAt,
      ts: new Date().toISOString(),
      selfTest: this.selfTest,
    };
    await writeAtomic(this.o.ctlDir, 'heartbeat.json', JSON.stringify(hb));
  }

  private async answerChallenges(): Promise<void> {
    if (!this.selfTest || this.stopped) return;
    const names = (await readdir(this.o.ctlDir))
      .filter((n) => /^challenge-[0-9a-f]{32}\.json$/.test(n))
      .slice(0, 8);
    for (const name of names) {
      const path = join(this.o.ctlDir, name);
      const raw = await readRegularFile(path, 1024);
      await unlink(path).catch(() => undefined);
      if (!raw) continue;
      let parsed;
      try {
        parsed = ChallengeSchema.safeParse(JSON.parse(raw.toString('utf8')));
      } catch {
        continue;
      }
      if (!parsed.success || `challenge-${parsed.data.id}.json` !== name) continue;
      await writeAtomic(
        this.o.ctlDir,
        `response-${parsed.data.id}.json`,
        JSON.stringify({
          v: 1,
          id: parsed.data.id,
          nonce: this.nonce,
          selfTestOk: this.selfTest.ok,
        }),
      );
    }
  }

  private async pollSlot(): Promise<void> {
    if (this.busy || this.stopped) return;
    const jobPath = join(this.o.slotDir, 'job.json');
    const resultPath = join(this.o.slotDir, 'result.json');
    if (
      !(await stat(jobPath).then(
        () => true,
        () => false,
      ))
    ) {
      this.lastJobId = '';
      return;
    }
    // A result already written for this slot occupant: wait for the worker to wipe the slot.
    if (
      await stat(resultPath).then(
        () => true,
        () => false,
      )
    )
      return;
    this.busy = true;
    this.running += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.running);
    try {
      const raw = await readRegularFile(jobPath, 4096);
      let jobId = ZERO_ID;
      let result: ResultFile;
      const parsed = raw ? safeJson(raw) : undefined;
      const job = parsed === undefined ? null : JobFileSchema.safeParse(parsed);
      if (!job || !job.success) {
        const maybe = (parsed as { jobId?: unknown } | undefined)?.jobId;
        if (typeof maybe === 'string' && /^[0-9a-f]{32}$/.test(maybe)) jobId = maybe;
        result = { v: 1, jobId, ok: false, code: 'malformed' };
      } else {
        jobId = job.data.jobId;
        if (jobId === this.lastJobId) return;
        this.lastJobId = jobId;
        const limits = clampLimits(job.data.limits);
        const inputPath = join(this.o.slotDir, 'input.bin');
        const r: ExtractResult = this.o.inProcess
          ? await extractFile(inputPath, job.data, limits)
          : await runExtraction(inputPath, job.data, limits);
        result = r.ok
          ? {
              v: 1,
              jobId,
              ok: true,
              kind: r.kind,
              ...(r.pages !== undefined ? { pages: r.pages } : {}),
              blocks: r.blocks,
            }
          : { v: 1, jobId, ok: false, code: r.code };
      }
      await writeAtomic(this.o.slotDir, 'result.json', JSON.stringify(result));
      this.log(
        {
          jobId,
          ok: result.ok,
          ...(result.ok ? { blocks: result.blocks.length } : { code: result.code }),
        },
        'parser job done',
      );
    } catch (err) {
      this.log({ err: (err as Error).message }, 'parser job crashed');
    } finally {
      this.running -= 1;
      this.busy = false;
    }
  }
}

function safeJson(b: Buffer): unknown {
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    return undefined;
  }
}
