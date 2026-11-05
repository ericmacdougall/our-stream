// SPDX-License-Identifier: AGPL-3.0-only
// Worker side of the parser sandbox protocol (see protocol.ts and docs/documents.md). Lives in this package so
// the worker and the sandbox runtime suite drive the very same client.
//  * attest(): a fresh heartbeat (short TTL) whose self-test passed, plus a live answer to a random
//    challenge carrying the parser's per-start nonce. A stale or forged file cannot answer a new challenge.
//    The attestation is a misconfiguration check only: a compromised parser can answer it.
//  * run(): exactly one job file is copied into the empty single slot, a job file is written last, and the
//    slot is wiped after the job whatever the outcome. The parser's output is untrusted: opened with
//    O_NOFOLLOW, a regular file directly under the slot, size-capped, schema-validated, bound to this job id.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_RESULT_FILE_BYTES, clampLimits, type ParseLimits } from './limits.js';
import {
  ChallengeResponseSchema,
  HeartbeatSchema,
  ResultFileSchema,
  type DocKind,
  type ResultFile,
} from './protocol.js';
import { hasNul, utf8Length } from './text.js';

export type UnavailableReason =
  | 'heartbeat_missing'
  | 'heartbeat_stale'
  | 'selftest_failed'
  | 'challenge_timeout'
  | 'nonce_mismatch'
  | 'busy';

/** The sandbox cannot be trusted or reached right now: retryable; fails the version when retries run out. */
export class ParserUnavailableError extends Error {
  constructor(public readonly reason: UnavailableReason) {
    super(`parser unavailable: ${reason}`);
    this.name = 'ParserUnavailableError';
  }
}

/** The parser produced no result in time (crash, cgroup kill or hang). */
export class ParserTimeoutError extends Error {
  constructor() {
    super('parser timeout');
    this.name = 'ParserTimeoutError';
  }
}

/** The parser's output broke the contract (symlink, non-regular file, oversize, schema, wrong job). Not retried. */
export class ParserOutputInvalidError extends Error {
  constructor(public readonly reason: string) {
    super(`parser output invalid: ${reason}`);
    this.name = 'ParserOutputInvalidError';
  }
}

export interface ParserClientOptions {
  slotDir: string;
  ctlDir: string;
  heartbeatTtlMs?: number;
  challengeTimeoutMs?: number;
  pollMs?: number;
  /** Extra time past the job's wall limit before the worker gives up waiting for a result. */
  resultGraceMs?: number;
  /** How long run() waits for another worker's job to leave the slot. */
  claimWaitMs?: number;
  now?: () => number;
}

export interface ParseSpec {
  kind: DocKind;
  mime: string | null;
  ext?: string | null;
  limits?: Partial<ParseLimits>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reads a regular file with O_NOFOLLOW; null when it is missing, a symlink, not a regular file or too big. */
export async function readRegularNoFollow(path: string, maxBytes: number): Promise<Buffer | null> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await fh.read(buf, off, st.size - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally {
    await fh.close();
  }
}

export class ParserClient {
  private readonly o: Required<Omit<ParserClientOptions, 'now'>> & { now: () => number };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: ParserClientOptions) {
    this.o = {
      heartbeatTtlMs: 15_000,
      challengeTimeoutMs: 5_000,
      pollMs: 100,
      resultGraceMs: 20_000,
      claimWaitMs: 150_000,
      now: () => Date.now(),
      ...opts,
    };
  }

  async attest(): Promise<{ nonce: string }> {
    const hbRaw = await readRegularNoFollow(join(this.o.ctlDir, 'heartbeat.json'), 4096);
    if (!hbRaw) throw new ParserUnavailableError('heartbeat_missing');
    let hb;
    try {
      hb = HeartbeatSchema.parse(JSON.parse(hbRaw.toString('utf8')));
    } catch {
      throw new ParserUnavailableError('heartbeat_missing');
    }
    const ts = Date.parse(hb.ts);
    const age = this.o.now() - ts;
    if (!Number.isFinite(ts) || age > this.o.heartbeatTtlMs || age < -5_000)
      throw new ParserUnavailableError('heartbeat_stale');
    const st = hb.selfTest;
    if (
      !st.ok ||
      st.network !== 'blocked' ||
      st.rootfs !== 'readonly' ||
      !st.nonRoot ||
      !st.noSecretEnv
    )
      throw new ParserUnavailableError('selftest_failed');

    const id = randomBytes(16).toString('hex');
    const challenge = join(this.o.ctlDir, `challenge-${id}.json`);
    const response = join(this.o.ctlDir, `response-${id}.json`);
    const tmp = join(this.o.ctlDir, `.challenge-${id}.tmp`);
    await writeFile(tmp, JSON.stringify({ v: 1, id }), { mode: 0o644 });
    await rename(tmp, challenge);
    try {
      const deadline = this.o.now() + this.o.challengeTimeoutMs;
      for (;;) {
        const raw = await readRegularNoFollow(response, 1024);
        if (raw) {
          let r;
          try {
            r = ChallengeResponseSchema.parse(JSON.parse(raw.toString('utf8')));
          } catch {
            throw new ParserUnavailableError('nonce_mismatch');
          }
          if (r.id !== id || r.nonce !== hb.nonce || !r.selfTestOk)
            throw new ParserUnavailableError('nonce_mismatch');
          return { nonce: r.nonce };
        }
        if (this.o.now() > deadline) throw new ParserUnavailableError('challenge_timeout');
        await sleep(this.o.pollMs);
      }
    } finally {
      await rm(challenge, { force: true }).catch(() => undefined);
      await rm(response, { force: true }).catch(() => undefined);
    }
  }

  /** Runs one job; calls are serialised within this process, and the on-disk claim covers other replicas. */
  run(
    inputPath: string,
    spec: ParseSpec,
  ): Promise<Extract<ResultFile, { ok: true }> | Extract<ResultFile, { ok: false }>> {
    const next = this.chain.then(() => this.runLocked(inputPath, spec));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async wipeSlot(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.o.slotDir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === '.claim') continue;
      // rm on a symlink removes the link, never its target.
      await rm(join(this.o.slotDir, n), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async takeClaim(wallMs: number): Promise<void> {
    await mkdir(this.o.slotDir, { recursive: true });
    const claim = join(this.o.slotDir, '.claim');
    const staleAfter = wallMs + this.o.resultGraceMs + 60_000;
    const deadline = this.o.now() + this.o.claimWaitMs;
    for (;;) {
      try {
        const fh = await open(
          claim,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o644,
        );
        await fh.writeFile(JSON.stringify({ pid: process.pid, at: this.o.now() }));
        await fh.close();
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const st = await stat(claim).catch(() => null);
      if (st && this.o.now() - st.mtimeMs > staleAfter) {
        await rm(claim, { force: true });
        continue;
      }
      if (this.o.now() > deadline) throw new ParserUnavailableError('busy');
      await sleep(250);
    }
  }

  private async runLocked(inputPath: string, spec: ParseSpec) {
    const limits = clampLimits(spec.limits);
    const jobId = randomBytes(16).toString('hex');
    await this.takeClaim(limits.wallMs);
    try {
      await this.wipeSlot();
      await copyFile(inputPath, join(this.o.slotDir, 'input.bin'), constants.COPYFILE_EXCL);
      const jobTmp = join(this.o.slotDir, '.job.json.tmp');
      await writeFile(
        jobTmp,
        JSON.stringify({
          v: 1,
          jobId,
          kind: spec.kind,
          declaredMime: spec.mime,
          declaredExt: spec.ext ?? null,
          limits: spec.limits ?? undefined,
        }),
        { mode: 0o644 },
      );
      await rename(jobTmp, join(this.o.slotDir, 'job.json'));
      const deadline = this.o.now() + limits.wallMs + this.o.resultGraceMs;
      const resultPath = join(this.o.slotDir, 'result.json');
      for (;;) {
        const present = await readdir(this.o.slotDir).then(
          (n) => n.includes('result.json'),
          () => false,
        );
        if (present) return await this.readResult(resultPath, jobId, limits);
        if (this.o.now() > deadline) throw new ParserTimeoutError();
        await sleep(this.o.pollMs);
      }
    } finally {
      await this.wipeSlot();
      await rm(join(this.o.slotDir, '.claim'), { force: true }).catch(() => undefined);
    }
  }

  private async readResult(path: string, jobId: string, limits: ParseLimits) {
    const raw = await readRegularNoFollow(path, MAX_RESULT_FILE_BYTES);
    if (!raw) throw new ParserOutputInvalidError('not a regular file, a symlink or oversize');
    let parsed: ResultFile;
    try {
      parsed = ResultFileSchema.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      throw new ParserOutputInvalidError('schema');
    }
    if (parsed.jobId !== jobId) throw new ParserOutputInvalidError('job id mismatch');
    if (parsed.ok) {
      let bytes = 0;
      for (const b of parsed.blocks) {
        if (hasNul(b.text)) throw new ParserOutputInvalidError('NUL in text');
        bytes += utf8Length(b.text);
        if (bytes > limits.maxTextBytes) throw new ParserOutputInvalidError('text over budget');
      }
      if (parsed.blocks.length > limits.maxBlocks)
        throw new ParserOutputInvalidError('too many blocks');
    }
    return parsed;
  }
}
