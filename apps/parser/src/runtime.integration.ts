// SPDX-License-Identifier: AGPL-3.0-only
// The parser sandbox on the real container runtime (M2a NEG-1, AC-2). The parser service is taken from
// infra/docker/docker-compose.yml exactly as `docker compose config` renders it (network_mode none, read-only
// root, tmpfs, non-root, no capabilities, pids and memory limits, no secrets); only the image source and the
// two volume sources are swapped so this process can play the worker with the real ParserClient. One fixture
// per NEG-1 case, each with a wall-clock budget, and after every case the same container must still be alive.
//
// Environment: PARSER_RUNTIME=compose enables it (skipped otherwise); the image is built from
// infra/docker/parser.Dockerfile unless PARSER_TEST_BUNDLE=<dir of `pnpm --filter @our-stream/parser deploy
// --prod --legacy`> is set, which runs the same service on node:24-bookworm-slim with that bundle mounted read-only instead
// (for hosts where an image build is too slow). The hostile container reuses the sandbox configuration.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ParserClient,
  ParserOutputInvalidError,
  ParserUnavailableError,
  chunkBlocks,
  type DocKind,
  type ParseLimits,
  type ResultFile,
} from '@our-stream/documents';
import { bigSheetXml, writeZeroBomb, xxeDocx } from './testing/fixtures.js';
import { docx, pdf, pptx, xlsx, zip } from './testing/builders.js';

const run = promisify(execFile);
const enabled = process.env['PARSER_RUNTIME'] === 'compose';
const repo = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const composeFile = join(repo, 'infra/docker/docker-compose.yml');
const project = `ostream-parser-rt-${Math.random().toString(16).slice(2, 8)}`;
const MIB = 1024 * 1024;
/** Wall-clock budget per fixture on a busy shared host; the parser's own limit is 120 s. */
const BUDGET_MS = 170_000;

const dc = (...args: string[]) =>
  run('docker', ['compose', '-p', project, ...args], { maxBuffer: 64 * MIB });
const docker = (...args: string[]) => run('docker', args, { maxBuffer: 64 * MIB });

describe.skipIf(!enabled)('parser sandbox on the compose runtime', () => {
  let io = '';
  let client: ParserClient;
  let hostile: ParserClient;
  let containerId = '';
  let hostileId = '';
  let startedAt = '';
  const names = { parser: `${project}-parser-1`, hostile: `${project}-parser-hostile-1` };
  const dirs = () => ({ open: join(io, 'open'), writable: join(io, 'writable') });
  const bundle = process.env['PARSER_TEST_BUNDLE'];

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const inspect = async (name: string) => JSON.parse((await docker('inspect', name)).stdout)[0];

  async function attested(c: ParserClient, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await c.attest();
      } catch (e) {
        if (!(e instanceof ParserUnavailableError) || Date.now() > deadline) throw e;
        await wait(2000);
      }
    }
  }

  beforeAll(async () => {
    io = await mkdtemp(join(tmpdir(), 'parser-rt-'));
    for (const d of ['slot', 'ctl', 'hostile/slot', 'hostile/ctl']) {
      await mkdir(join(io, d), { recursive: true });
      await chmod(join(io, d), 0o777); // the container user is uid 1000; the host user may not be
    }
    await chmod(join(io, 'hostile'), 0o777);
    const rendered = JSON.parse(
      (
        await run('docker', ['compose', '-f', composeFile, 'config', '--format', 'json'], {
          maxBuffer: 64 * MIB,
        })
      ).stdout,
    );
    const base = rendered.services.parser;
    const swap = (slot: string, ctl: string, extra: Record<string, unknown> = {}) => {
      const svc = JSON.parse(JSON.stringify(base));
      svc.volumes = [
        { type: 'bind', source: slot, target: '/slot' },
        { type: 'bind', source: ctl, target: '/ctl' },
      ];
      if (bundle) {
        delete svc.build;
        svc.image = 'node:24-bookworm-slim';
        svc.working_dir = '/app';
        svc.command = ['node', 'dist/main.js']; // as in parser.Dockerfile: no V8 flags (see there)
        svc.volumes.push({ type: 'bind', source: bundle, target: '/app', read_only: true });
      }
      delete svc.healthcheck; // readiness is the worker-side attestation below
      return { ...svc, ...extra };
    };
    const hostileSvc = swap(join(io, 'hostile/slot'), join(io, 'hostile/ctl'));
    hostileSvc.command = ['node', '/hostile/hostile-parser.mjs'];
    hostileSvc.volumes.push({
      type: 'bind',
      source: join(repo, 'apps/parser/hostile'),
      target: '/hostile',
      read_only: true,
    });
    // One image for both: the bundle runs on node:24-bookworm-slim; a build is tagged once and shared.
    const parserSvc = swap(join(io, 'slot'), join(io, 'ctl'));
    if (!bundle) {
      parserSvc.image = `${project}-parser:test`;
      hostileSvc.image = parserSvc.image;
      delete hostileSvc.build;
    }
    // Misconfigured copies of the sandbox: the same service with one protection removed. Their start-up
    // self-test must say so and the worker must refuse to attest them (the "same self-test" of compose and Helm).
    const broken = (name: string, dir: string, mutate: (svc: Record<string, unknown>) => void) => {
      const svc = swap(join(io, dir, 'slot'), join(io, dir, 'ctl'));
      if (!bundle) {
        svc.image = parserSvc.image;
        delete svc.build;
      }
      mutate(svc);
      return [name, svc] as const;
    };
    const openSvc = broken('parser-open', 'open', (svc) => {
      delete svc.network_mode; // default bridge network: outbound connections work
    });
    const writableSvc = broken('parser-writable', 'writable', (svc) => {
      svc.read_only = false;
    });
    for (const d of ['open', 'writable']) {
      for (const sub of ['', '/slot', '/ctl']) {
        await mkdir(join(io, d + sub), { recursive: true });
        await chmod(join(io, d + sub), 0o777);
      }
    }
    const file = join(io, 'compose.json');
    await writeFile(
      file,
      JSON.stringify({
        name: project,
        services: {
          parser: parserSvc,
          'parser-hostile': hostileSvc,
          [openSvc[0]]: openSvc[1],
          [writableSvc[0]]: writableSvc[1],
        },
      }),
    );
    await dc('-f', file, 'up', '-d', '--no-deps', ...(bundle ? ['--no-build'] : ['--build']));
    client = new ParserClient({
      slotDir: join(io, 'slot'),
      ctlDir: join(io, 'ctl'),
      pollMs: 200,
      challengeTimeoutMs: 10_000,
      resultGraceMs: 30_000,
      claimWaitMs: 5_000,
    });
    hostile = new ParserClient({
      slotDir: join(io, 'hostile/slot'),
      ctlDir: join(io, 'hostile/ctl'),
      pollMs: 100,
      challengeTimeoutMs: 10_000,
      resultGraceMs: 30_000,
    });
    await Promise.all([attested(client, 25 * 60_000), attested(hostile, 25 * 60_000)]);
    const info = await inspect(names.parser);
    containerId = info.Id;
    startedAt = info.State.StartedAt;
    hostileId = (await inspect(names.hostile)).Id;
  }, 30 * 60_000);

  afterAll(async () => {
    // docker stop only (short grace: node as PID 1 ignores SIGTERM); containers are left stopped for the operator.
    const all = [
      names.parser,
      names.hostile,
      `${project}-parser-open-1`,
      `${project}-parser-writable-1`,
    ];
    await Promise.all(all.map((n) => docker('stop', '-t', '2', n).catch(() => undefined)));
  }, 600_000);

  const spec = (kind: DocKind, mime: string | null = null, limits?: Partial<ParseLimits>) => ({
    kind,
    mime,
    ...(limits ? { limits } : {}),
  });
  const MIMES: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    md: 'text/markdown',
  };

  async function parse(
    data: Buffer | string,
    kind: DocKind,
    limits?: Partial<ParseLimits>,
  ): Promise<ResultFile & { ms: number }> {
    const f = join(io, `in-${Math.random().toString(16).slice(2)}`);
    await writeFile(f, data);
    const t = Date.now();
    const r = await client.run(f, spec(kind, MIMES[kind] ?? null, limits));
    return { ...r, ms: Date.now() - t };
  }
  async function alive() {
    const info = await inspect(names.parser);
    expect(info.Id).toBe(containerId);
    expect(info.State.Running).toBe(true);
    expect(info.State.StartedAt, 'the parser container was restarted').toBe(startedAt);
    expect(info.RestartCount).toBe(0);
    await attested(client, 30_000);
  }
  async function refused(
    code: string,
    data: Buffer | string,
    kind: DocKind,
    limits?: Partial<ParseLimits>,
  ) {
    const r = await parse(data, kind, limits);
    expect(r.ok, `expected ${code}, got ${JSON.stringify(r).slice(0, 200)}`).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
    expect(r.ms).toBeLessThan(BUDGET_MS);
    await alive();
  }

  it('control: a real document is parsed in the container and the attestation matches the live parser', async () => {
    const r = await parse(
      docx([
        { text: 'Runtime control', style: 'Heading1' },
        { text: 'Parsed inside the sandbox.' },
      ]),
      'docx',
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(chunkBlocks(r.blocks)).toEqual([
        {
          locator: { heading: 'Runtime control' },
          text: 'Runtime control\n\nParsed inside the sandbox.',
          lang: 'en',
        },
      ]);
    const hb = JSON.parse(await readFile(join(io, 'ctl/heartbeat.json'), 'utf8'));
    expect(hb.selfTest).toEqual({
      ok: true,
      network: 'blocked',
      rootfs: 'readonly',
      nonRoot: true,
      noSecretEnv: true,
    });
  });

  it('the container runs with the compose sandbox settings', async () => {
    const info = await inspect(names.parser);
    const hc = info.HostConfig;
    expect(hc.NetworkMode).toBe('none');
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.CapAdd ?? []).toEqual([]);
    expect(hc.Privileged).toBe(false);
    expect(hc.PidsLimit).toBe(128);
    expect(hc.Memory).toBe(1024 ** 3);
    expect(hc.SecurityOpt).toContain('no-new-privileges:true');
    expect(info.Config.User).toBe('1000:1000');
    expect(Object.keys(hc.Tmpfs ?? {})).toEqual(['/tmp']);
    const envKeys = (info.Config.Env as string[]).map((e) => e.split('=')[0] as string);
    expect(
      envKeys.filter((k) => /PASSWORD|SECRET|TOKEN|DATABASE|S3_|ACCESS_KEY|SMTP/i.test(k)),
    ).toEqual([]);
    const mounts = (info.Mounts as { Destination: string }[]).map((m) => m.Destination).sort();
    expect(mounts).toEqual(bundle ? ['/app', '/ctl', '/slot'] : ['/ctl', '/slot']);
  });

  it('sandbox probes inside the running container: no network, no writes outside tmpfs, no secrets, no sight of other jobs', async () => {
    const sh = (script: string) => docker('exec', names.parser, 'node', '-e', script);
    const net = await sh(
      `const n=require('node:net');const s=n.connect({host:'1.1.1.1',port:443});s.setTimeout(2000,()=>{console.log('blocked');process.exit(0)});s.on('connect',()=>{console.log('OPEN');process.exit(0)});s.on('error',(e)=>{console.log('blocked '+e.code);process.exit(0)})`,
    );
    expect(net.stdout).toMatch(/^blocked/);
    const dns = await sh(
      `require('node:dns').lookup('example.com',(e)=>{console.log(e?'blocked':'OPEN');process.exit(0)})`,
    );
    expect(dns.stdout).toMatch(/^blocked/);
    const write = await sh(
      `try{require('fs').writeFileSync('/etc/pwned','x');console.log('WRITABLE')}catch(e){console.log(e.code)}`,
    );
    expect(write.stdout.trim()).toMatch(/EROFS|EACCES/);
    const tmp = await sh(`require('fs').writeFileSync('/tmp/ok','x');console.log('tmp ok')`);
    expect(tmp.stdout).toContain('tmp ok');
    // A canary in the worker's side of the io directory (outside both mounted volumes) is invisible.
    await writeFile(join(io, 'worker-canary.txt'), 'WORKER-CANARY');
    const see = await sh(
      `const fs=require('fs');const out=[];for(const p of ['/worker-canary.txt','/slot/../worker-canary.txt','/ctl/../worker-canary.txt','/hostile/slot'])out.push(fs.existsSync(p));console.log(JSON.stringify(out))`,
    );
    expect(JSON.parse(see.stdout)).toEqual([false, false, false, false]);
    const uid = await sh(`console.log(process.getuid())`);
    expect(uid.stdout.trim()).toBe('1000');
  });

  it('the memory cgroup is real: a 1.5 GiB allocation inside the container is OOM-killed and the parser survives', async () => {
    const r = await docker(
      'exec',
      names.parser,
      'node',
      '-e',
      `const b=Buffer.alloc(1.5*1024**3,1);console.log('ALLOCATED '+b.length)`,
    ).then(
      (x) => ({ code: 0, out: x.stdout }),
      (e: { code?: number; stdout?: string }) => ({ code: e.code ?? 1, out: e.stdout ?? '' }),
    );
    expect(r.out).not.toContain('ALLOCATED');
    expect(r.code).not.toBe(0);
    await alive();
  });

  it('NEG-1 OOXML: uncompressed over 500 MB (a real 520 MiB bomb), ratio over 200, a lying header', async () => {
    const f = join(io, 'bomb500.docx');
    await writeZeroBomb(f, 520 * MIB);
    await refused('ooxml_too_large', await readFile(f), 'docx');
    const g = join(io, 'ratio.docx');
    await writeZeroBomb(g, 30 * MIB);
    await refused('ooxml_ratio', await readFile(g), 'docx');
    const h = join(io, 'lie.docx');
    await writeZeroBomb(h, 40 * MIB, { lieAboutSize: 100 * 1024 });
    await refused('malformed', await readFile(h), 'docx');
  });

  it('NEG-1 PDF over 500 pages, embedded JavaScript ignored (control), password-protected', async () => {
    await refused(
      'pdf_pages',
      pdf(Array.from({ length: 501 }, (_, i) => [`page ${i + 1}`])),
      'pdf',
    );
    const ok = await parse(pdf([['Active content stays inert']], { script: true }), 'pdf');
    expect(ok.ok).toBe(true);
    await refused('password_protected', pdf([['secret']], { encrypt: true }), 'pdf');
  });

  it('NEG-1 file over 100 MiB (real size), extracted text over 5 MB, CSV line over 1 MiB, NUL bytes', async () => {
    const big = join(io, 'big.md');
    await writeFile(big, Buffer.alloc(101 * MIB, 0x61));
    await refused('file_too_large', await readFile(big), 'md');
    await refused(
      'text_too_large',
      `# T\n\n${'paragraph words go here. '.repeat(250_000)}\n`,
      'md',
    );
    await refused('csv_line', `a,b\n${'x'.repeat(MIB + 10)},y\n`, 'csv');
    await refused('nul_bytes', Buffer.from('a,b\n1,\u00002\n'), 'csv');
  });

  it('NEG-1 XLSX over 1,000,000 cells (streamed), formulas and external links never evaluated', async () => {
    const x = xlsx([{ name: 'Big', rows: [['x']] }], { sheetXml: () => bigSheetXml(1_000_100) });
    await refused('cell_limit', x, 'xlsx');
    const ok = await parse(
      xlsx([{ name: 'S', rows: [['linked', { f: "'[1]Sheet1'!A1+EVIL-MARKER", v: 'cached' }]] }], {
        extra: [
          {
            name: 'xl/externalLinks/_rels/externalLink1.xml.rels',
            data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="http://169.254.169.254/latest/" TargetMode="External"/></Relationships>',
          },
        ],
      }),
      'xlsx',
    );
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(ok)).not.toMatch(/EVIL-MARKER|169\.254/);
  });

  it('NEG-1 wall-clock and memory budgets end the job, the container keeps running (real parser control)', async () => {
    const heavy = pdf(Array.from({ length: 400 }, (_, i) => [`page ${i}`, 'words '.repeat(60)]));
    await refused('wall_time', heavy, 'pdf', { wallMs: 5 });
    expect((await parse(heavy, 'pdf')).ok).toBe(true);
    const mem = docx(
      Array.from({ length: 60_000 }, (_, i) => ({
        text: `paragraph number ${i} with some padding text to take memory`,
      })),
    );
    await refused('memory', mem, 'docx', { heapMb: 24 });
    expect((await parse(mem, 'docx')).ok).toBe(true);
  });

  it('NEG-1 spoofed type, macros, unsafe archive paths, XXE/DTD, no_text, malformed', async () => {
    await refused('spoofed_type', '<html><script>alert(1)</script></html>', 'docx');
    await refused('spoofed_type', pdf([['x']]), 'docx');
    await refused('macro_enabled', docx([{ text: 'x' }], { macro: true }), 'docx');
    await refused(
      'unsafe_path',
      docx([{ text: 'x' }], { extra: [{ name: '../evil.xml', data: 'z' }] }),
      'docx',
    );
    await refused(
      'unsafe_path',
      docx([{ text: 'x' }], { extra: [{ name: '/abs/evil.xml', data: 'z' }] }),
      'docx',
    );
    await refused('xml_dtd', xxeDocx(), 'docx');
    await refused('no_text', docx([{ text: 'gone', deleted: true }]), 'docx');
    await refused('no_text', pptx([{ paras: ['hidden only'], hidden: true }]), 'pptx');
    await refused('malformed', zip([{ name: 'x', data: 'y' }]).subarray(0, 10), 'xlsx');
    // control for the XXE fixture: the same document without the DTD parses.
    expect((await parse(docx([{ text: 'before after' }]), 'docx')).ok).toBe(true);
  });

  it('a canary from another job is unreadable inside the slot and absent from the output', async () => {
    const canary = 'CANARY-JOB-ONE-77120';
    await parse(docx([{ text: canary }]), 'docx');
    const f = join(io, 'job2.md');
    await writeFile(f, '# Two\n\nsecond job text\n');
    // While job two runs, list the slot from inside the container.
    const pending = client.run(f, spec('md', MIMES['md']));
    let listing = '';
    for (let i = 0; i < 40 && !listing.includes('input.bin'); i += 1) {
      listing = (await docker('exec', names.parser, 'ls', '-A', '/slot')).stdout;
      await wait(100);
    }
    const r = await pending;
    expect(JSON.stringify(r)).not.toContain(canary);
    if (listing)
      expect(
        listing
          .split('\n')
          .filter(Boolean)
          .every((n) => ['input.bin', 'job.json', 'result.json', '.claim'].includes(n)),
      ).toBe(true);
    const after = (await docker('exec', names.parser, 'ls', '-A', '/slot')).stdout
      .split('\n')
      .filter(Boolean);
    expect(after.filter((n) => n !== '.claim')).toEqual([]); // wiped after the job
    await alive();
  });

  it('a hostile parser that answers attestation is still refused on its output: symlink, FIFO, directory, oversize, wrong job, garbage', async () => {
    const cases: [DocKind, RegExp][] = [
      ['pdf', /symlink|regular/],
      ['docx', /regular/],
      ['pptx', /regular/],
      ['xlsx', /regular/],
      ['csv', /job id mismatch/],
      ['md', /schema/],
    ];
    for (const [kind, reason] of cases) {
      const f = join(io, `h-${kind}`);
      await writeFile(f, 'bytes');
      const err = await hostile.run(f, spec(kind, MIMES[kind])).catch((e: Error) => e);
      expect(err, kind).toBeInstanceOf(ParserOutputInvalidError);
      expect((err as ParserOutputInvalidError).reason, kind).toMatch(reason);
      // the worker wiped everything, including the canary the hostile parser planted
      expect(
        await docker('exec', names.hostile, 'ls', '-A', '/slot').then((x) =>
          x.stdout.split('\n').filter((n) => n && n !== '.claim'),
        ),
      ).toEqual([]);
    }
    expect((await inspect(names.hostile)).Id).toBe(hostileId);
  });

  it(
    'a sandbox started WITHOUT its network isolation or read-only root reports it and is never attested (the self-test, failing control)',
    async () => {
      for (const [which, expected] of [
        ['open', { network: 'open' }],
        ['writable', { rootfs: 'writable' }],
      ] as const) {
        const c = new ParserClient({
          slotDir: join(dirs()[which], 'slot'),
          ctlDir: join(dirs()[which], 'ctl'),
          pollMs: 200,
          challengeTimeoutMs: 10_000,
        });
        const hbPath = join(dirs()[which], 'ctl/heartbeat.json');
        let hb: { selfTest: Record<string, unknown> } | null = null;
        for (let i = 0; i < 300 && hb === null; i += 1) {
          hb = await readFile(hbPath, 'utf8').then(
            (t) => JSON.parse(t),
            () => null,
          );
          if (hb === null) await wait(2000);
        }
        expect(hb, `${which} sandbox never published a heartbeat`).not.toBeNull();
        expect(hb?.selfTest).toMatchObject({ ok: false, ...expected });
        const err = await c.attest().catch((e: Error) => e);
        expect(err, which).toBeInstanceOf(ParserUnavailableError);
        expect((err as ParserUnavailableError).reason, which).toBe('selftest_failed');
      }
    },
    20 * 60_000,
  );

  it(
    'the worker refuses a stopped (stale) parser: no fresh heartbeat, then recovers when it is back',
    async () => {
      await docker('stop', '-t', '5', names.parser);
      const t = Date.now();
      let reason: string;
      for (;;) {
        try {
          await client.attest();
          reason = 'attested';
          break;
        } catch (e) {
          reason = (e as ParserUnavailableError).reason;
          if (reason === 'heartbeat_stale' || Date.now() - t > 60_000) break;
          await wait(2000);
        }
      }
      expect(['heartbeat_stale', 'challenge_timeout']).toContain(reason);
      await expect(client.attest()).rejects.toBeInstanceOf(ParserUnavailableError);
      await docker('start', names.parser);
      await attested(client, 10 * 60_000);
      startedAt = (await inspect(names.parser)).State.StartedAt;
      expect((await parse(docx([{ text: 'back again' }]), 'docx')).ok).toBe(true);
    },
    15 * 60_000,
  );
});
