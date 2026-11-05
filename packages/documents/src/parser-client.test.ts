// SPDX-License-Identifier: AGPL-3.0-only
// The worker's side of the sandbox protocol against a scripted sandbox: attestation (fresh heartbeat plus a
// live challenge answer), the single job slot (one input file, wiped after every job, a canary from another
// job unreadable and absent from the output) and untrusted-output handling (symlink, FIFO, directory,
// oversize, schema, wrong job).
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ParserClient,
  ParserOutputInvalidError,
  ParserTimeoutError,
  ParserUnavailableError,
  type UnavailableReason,
} from './parser-client.js';
import { SandboxSim, type SandboxSimOptions } from './testing/sandbox-sim.js';

let dir = '';
let sims: SandboxSim[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pc-'));
});
afterEach(() => {
  for (const s of sims) s.stop();
  sims = [];
});

const dirs = () => ({ slotDir: join(dir, 'slot'), ctlDir: join(dir, 'ctl') });
async function sim(o: Partial<SandboxSimOptions> = {}) {
  for (const old of sims) old.stop(); // one scripted sandbox at a time
  sims = [];
  const s = new SandboxSim({ ...dirs(), ...o });
  sims.push(s);
  await s.start();
  return s;
}
const client = (over: Record<string, number> = {}) =>
  new ParserClient({
    ...dirs(),
    pollMs: 10,
    // Generous on purpose: dev2 runs at a load of 100+ and a starved timer must not read as a missing answer.
    challengeTimeoutMs: 4000,
    resultGraceMs: 5000,
    claimWaitMs: 8000,
    ...over,
  });
const reasonOf = async (p: Promise<unknown>): Promise<UnavailableReason | 'ok'> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof ParserUnavailableError) return e.reason;
    throw e;
  }
};
const input = async (text = 'x') => {
  const p = join(dir, `in-${Math.random().toString(16).slice(2)}`);
  await writeFile(p, text);
  return p;
};
const spec = { kind: 'docx' as const, mime: null };

describe('attestation', () => {
  it('control: a fresh heartbeat and a live challenge answer attest', async () => {
    const s = await sim();
    await expect(client().attest()).resolves.toEqual({ nonce: s.nonce });
  });

  it('refuses when no heartbeat exists', async () => {
    await sim({ heartbeat: false });
    expect(await reasonOf(client().attest())).toBe('heartbeat_missing');
  });

  it('refuses a stale heartbeat', async () => {
    await sim({ tsOffsetMs: -60_000 });
    expect(await reasonOf(client().attest())).toBe('heartbeat_stale');
  });

  it('refuses when the self-test failed', async () => {
    await sim({ selfTestOk: false });
    expect(await reasonOf(client().attest())).toBe('selftest_failed');
  });

  it('refuses a forged static heartbeat that nothing answers for (no live parser behind it)', async () => {
    const s = await sim();
    s.stop();
    await writeFile(
      join(dirs().ctlDir, 'heartbeat.json'),
      JSON.stringify({
        v: 1,
        nonce: s.nonce,
        startedAt: new Date().toISOString(),
        ts: new Date().toISOString(),
        selfTest: {
          ok: true,
          network: 'blocked',
          rootfs: 'readonly',
          nonRoot: true,
          noSecretEnv: true,
        },
      }),
    );
    expect(await reasonOf(client().attest())).toBe('challenge_timeout');
  });

  it('refuses an answer carrying another nonce', async () => {
    await sim({ responseNonce: 'a'.repeat(32) });
    expect(await reasonOf(client().attest())).toBe('nonce_mismatch');
  });

  it('removes its challenge and response files', async () => {
    await sim();
    await client().attest();
    const left = (await readdir(dirs().ctlDir)).filter(
      (n) => n.startsWith('challenge-') || n.startsWith('response-'),
    );
    expect(left).toEqual([]);
  });
});

describe('job slot', () => {
  it('copies exactly one input file plus the job file, returns the validated result and wipes the slot', async () => {
    const s = await sim({
      behaviour: () => ({ kind: 'blocks', blocks: [{ text: 'hello', locator: { page: 1 } }] }),
    });
    const r = await client().run(await input('payload'), spec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.blocks).toEqual([{ text: 'hello', locator: { page: 1 } }]);
    expect(s.jobs).toHaveLength(1);
    expect(s.jobs[0]?.slotFiles.sort()).toEqual(['input.bin', 'job.json']);
    expect(await readdir(dirs().slotDir)).toEqual([]); // wiped; the claim is released too
  });

  it('a canary from another job is never in the slot and never in the output', async () => {
    const canary = 'CANARY-OTHER-JOB-4409';
    const other = await input(canary);
    const s = await sim({
      behaviour: () => ({ kind: 'blocks', blocks: [{ text: 'job two text', locator: {} }] }),
    });
    const c = client();
    await c.run(other, spec);
    const r = await c.run(await input('second'), spec);
    expect(JSON.stringify(r)).not.toContain(canary);
    expect(s.jobs).toHaveLength(2);
    for (const j of s.jobs) expect(j.slotFiles.sort()).toEqual(['input.bin', 'job.json']);
    // the second job's slot never held the first job's bytes
    expect(await readdir(dirs().slotDir)).toEqual([]);
  });

  it('wipes leftovers of an earlier crashed job before copying (even directories and symlinks)', async () => {
    const { slotDir } = dirs();
    await mkdir(join(slotDir, 'sub'), { recursive: true });
    await writeFile(join(slotDir, 'old-input.bin'), 'leftover');
    const s = await sim({
      behaviour: () => ({ kind: 'blocks', blocks: [{ text: 't', locator: {} }] }),
    });
    await client().run(await input(), spec);
    expect(s.jobs[0]?.slotFiles.sort()).toEqual(['input.bin', 'job.json']);
  });

  it('serialises concurrent runs in one process (the slot holds one job at a time)', async () => {
    let active = 0;
    let max = 0;
    await sim({
      behaviour: () => {
        active += 1;
        max = Math.max(max, active);
        setTimeout(() => (active -= 1), 5);
        return { kind: 'blocks', blocks: [{ text: 't', locator: {} }] };
      },
    });
    const c = client();
    const results = await Promise.all([
      c.run(await input(), spec),
      c.run(await input(), spec),
      c.run(await input(), spec),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(max).toBe(1);
  });

  it('a second worker waits for a fresh claim and gives up as busy', async () => {
    const { slotDir } = dirs();
    await mkdir(slotDir, { recursive: true });
    await writeFile(join(slotDir, '.claim'), '{}');
    await sim();
    expect(await reasonOf(client({ claimWaitMs: 150 }).run(await input(), spec))).toBe('busy');
  });

  it('times out when the parser never answers and still wipes the slot', async () => {
    await sim({ behaviour: () => ({ kind: 'hang' }) });
    const c = client({ resultGraceMs: 100 });
    await expect(c.run(await input(), { ...spec, limits: { wallMs: 100 } })).rejects.toBeInstanceOf(
      ParserTimeoutError,
    );
    expect(await readdir(dirs().slotDir)).toEqual([]);
  });
});

describe('parser output is untrusted', () => {
  const bad = async (behaviour: SandboxSimOptions['behaviour']) => {
    await sim({ behaviour });
    const err = await client()
      .run(await input(), spec)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ParserOutputInvalidError);
    expect(await readdir(dirs().slotDir)).toEqual([]);
    return (err as ParserOutputInvalidError).reason;
  };

  it('NEG-1: a symlink to a worker-readable file holding a VALID result for this very job is refused', async () => {
    const target = join(dir, 'worker-readable.json');
    const reason = await bad((job) => {
      // The link target is a perfectly valid, matching result: only the O_NOFOLLOW refusal stands in the way.
      writeFileSync(
        target,
        JSON.stringify({
          v: 1,
          jobId: job.jobId,
          ok: true,
          kind: 'docx',
          blocks: [{ text: 'SMUGGLED', locator: {} }],
        }),
      );
      return { kind: 'symlink', target };
    });
    expect(reason).toMatch(/symlink|regular/);
    expect(existsSync(target)).toBe(true); // control: the target exists and is readable by the worker
  });

  it('refuses a FIFO, a directory, oversize output, garbage and another job id', async () => {
    await bad(() => ({ kind: 'fifo' }));
    await bad(() => ({ kind: 'directory' }));
    await bad(() => ({ kind: 'oversize' }));
    expect(await bad(() => ({ kind: 'garbage', body: '{"v":1}' }))).toBe('schema');
    expect(await bad(() => ({ kind: 'wrong-job' }))).toBe('job id mismatch');
  });

  it('refuses NUL text', async () => {
    expect(await bad(() => ({ kind: 'blocks', blocks: [{ text: 'a\u0000b', locator: {} }] }))).toBe(
      'NUL in text',
    );
  });

  it('refuses text over the budget', async () => {
    await sim({
      behaviour: () => ({ kind: 'blocks', blocks: [{ text: 'x'.repeat(2000), locator: {} }] }),
    });
    const e = await client()
      .run(await input(), { ...spec, limits: { maxTextBytes: 1000 } })
      .catch((x: Error) => x);
    expect((e as ParserOutputInvalidError).reason).toBe('text over budget');
  });

  it('passes a refusal result through (the neutral code only)', async () => {
    await sim({ behaviour: () => ({ kind: 'refuse', code: 'xml_dtd' }) });
    expect(await client().run(await input(), spec)).toMatchObject({ ok: false, code: 'xml_dtd' });
  });
});
