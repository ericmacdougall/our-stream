// SPDX-License-Identifier: AGPL-3.0-only
// Test double for the parser sandbox: speaks the file protocol (heartbeat, challenge, one job slot) with
// scripted behaviour, including hostile outputs. Exported through `@our-stream/documents/testing`.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Block, Heartbeat, JobFile, ResultFile } from '../protocol.js';

export type Behaviour =
  | { kind: 'blocks'; blocks: Block[] }
  | { kind: 'refuse'; code: Extract<ResultFile, { ok: false }>['code'] }
  | { kind: 'symlink'; target: string }
  | { kind: 'fifo' }
  | { kind: 'directory' }
  | { kind: 'garbage'; body: string }
  | { kind: 'wrong-job' }
  | { kind: 'oversize' }
  | { kind: 'hang' };

export interface SandboxSimOptions {
  slotDir: string;
  ctlDir: string;
  /** Write heartbeat.json (false: a missing heartbeat). */
  heartbeat?: boolean | undefined;
  /** Answer challenges (false: a forged static heartbeat nobody is behind). */
  answer?: boolean | undefined;
  selfTestOk?: boolean | undefined;
  /** Heartbeat timestamp offset in ms (negative: stale). */
  tsOffsetMs?: number | undefined;
  /** Nonce in the challenge response (default: the heartbeat nonce). */
  responseNonce?: string | undefined;
  behaviour?: ((job: JobFile, slotFiles: string[]) => Behaviour) | undefined;
  pollMs?: number | undefined;
}

/** Whole file, then rename into place: the client must never see a half-written result by accident. */
async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}

export class SandboxSim {
  readonly nonce = randomBytes(16).toString('hex');
  readonly jobs: { job: JobFile; slotFiles: string[] }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private done = new Set<string>();
  constructor(private readonly o: SandboxSimOptions) {}

  async start(): Promise<void> {
    await mkdir(this.o.slotDir, { recursive: true });
    await mkdir(this.o.ctlDir, { recursive: true });
    if (this.o.heartbeat !== false) await this.beat();
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.o.pollMs ?? 20);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async beat(): Promise<void> {
    const hb: Heartbeat = {
      v: 1,
      nonce: this.nonce,
      startedAt: new Date().toISOString(),
      ts: new Date(Date.now() + (this.o.tsOffsetMs ?? 0)).toISOString(),
      selfTest: {
        ok: this.o.selfTestOk ?? true,
        network: this.o.selfTestOk === false ? 'open' : 'blocked',
        rootfs: 'readonly',
        nonRoot: true,
        noSecretEnv: true,
      },
    };
    await writeFile(join(this.o.ctlDir, '.hb.tmp'), JSON.stringify(hb));
    await rename(join(this.o.ctlDir, '.hb.tmp'), join(this.o.ctlDir, 'heartbeat.json'));
  }

  private async tick(): Promise<void> {
    if (this.o.heartbeat !== false) await this.beat();
    if (this.o.answer !== false) {
      for (const n of await readdir(this.o.ctlDir)) {
        const m = /^challenge-([0-9a-f]{32})\.json$/.exec(n);
        if (!m) continue;
        const id = m[1] as string;
        await writeFile(
          join(this.o.ctlDir, `.r-${id}.tmp`),
          JSON.stringify({
            v: 1,
            id,
            nonce: this.o.responseNonce ?? this.nonce,
            selfTestOk: this.o.selfTestOk ?? true,
          }),
        );
        await rename(
          join(this.o.ctlDir, `.r-${id}.tmp`),
          join(this.o.ctlDir, `response-${id}.json`),
        );
      }
    }
    await this.pollSlot();
  }

  private async pollSlot(): Promise<void> {
    if (this.busy) return;
    const files = await readdir(this.o.slotDir).catch(() => [] as string[]);
    if (!files.includes('job.json') || files.includes('result.json')) return;
    let job: JobFile;
    try {
      job = JSON.parse(await readFile(join(this.o.slotDir, 'job.json'), 'utf8')) as JobFile;
    } catch {
      return;
    }
    if (this.done.has(job.jobId)) return;
    this.done.add(job.jobId);
    this.busy = true;
    try {
      this.jobs.push({ job, slotFiles: files.filter((f) => !f.startsWith('.')) });
      const b = this.o.behaviour?.(job, files) ?? { kind: 'refuse', code: 'internal' };
      const out = join(this.o.slotDir, 'result.json');
      const jobId = job.jobId;
      switch (b.kind) {
        case 'blocks':
          await writeFile(
            out,
            JSON.stringify({ v: 1, jobId, ok: true, kind: job.kind, blocks: b.blocks }),
          );
          break;
        case 'refuse':
          await atomicWrite(out, JSON.stringify({ v: 1, jobId, ok: false, code: b.code }));
          break;
        case 'symlink':
          await symlink(b.target, out);
          break;
        case 'fifo':
          execFileSync('mkfifo', [out]);
          break;
        case 'directory':
          await mkdir(out);
          break;
        case 'garbage':
          await atomicWrite(out, b.body);
          break;
        case 'wrong-job':
          await writeFile(
            out,
            JSON.stringify({ v: 1, jobId: 'f'.repeat(32), ok: false, code: 'internal' }),
          );
          break;
        case 'oversize':
          await atomicWrite(out, Buffer.alloc(33 * 1024 * 1024, 0x20));
          break;
        case 'hang':
          break;
      }
    } finally {
      this.busy = false;
    }
  }
}
