// SPDX-License-Identifier: AGPL-3.0-only
// TEST ONLY. A deliberately hostile stand-in for the parser, run in the same sandbox container configuration by
// the runtime suite (src/runtime.integration.ts). It answers attestation like a compromised parser would
// (heartbeat and challenge answers are lies the worker cannot detect) and then breaks the output contract in a
// way chosen by the job's kind, so the suite can prove the worker refuses every one of them:
//   pdf  -> result.json is a relative symlink to a valid, worker-readable file (../ctl/heartbeat.json)
//   docx -> result.json is a FIFO          pptx -> a directory       xlsx -> 33 MiB of padding
//   csv  -> a result for another job id    md   -> not JSON
//   (any kind) also plants a canary file in the slot that the worker must wipe.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const slot = process.env.PARSER_SLOT_DIR ?? '/slot';
const ctl = process.env.PARSER_CTL_DIR ?? '/ctl';
const nonce = randomBytes(16).toString('hex');
const done = new Set();
mkdirSync(slot, { recursive: true });
mkdirSync(ctl, { recursive: true });

// Written whole and renamed into place, so the worker never reads a half-written file by accident.
function atomic(path, data) {
  writeFileSync(`${path}.tmp`, data);
  renameSync(`${path}.tmp`, path);
}

function beat() {
  const hb = {
    v: 1,
    nonce,
    startedAt: new Date().toISOString(),
    ts: new Date().toISOString(),
    selfTest: {
      ok: true,
      network: 'blocked',
      rootfs: 'readonly',
      nonRoot: true,
      noSecretEnv: true,
    },
  };
  writeFileSync(join(ctl, '.hb.tmp'), JSON.stringify(hb));
  renameSync(join(ctl, '.hb.tmp'), join(ctl, 'heartbeat.json'));
}

setInterval(() => {
  beat();
  for (const n of readdirSync(ctl)) {
    const m = /^challenge-([0-9a-f]{32})\.json$/.exec(n);
    if (!m) continue;
    writeFileSync(join(ctl, `.r.tmp`), JSON.stringify({ v: 1, id: m[1], nonce, selfTestOk: true }));
    renameSync(join(ctl, '.r.tmp'), join(ctl, `response-${m[1]}.json`));
    unlinkSync(join(ctl, n));
  }
  const files = readdirSync(slot);
  if (!files.includes('job.json') || files.includes('result.json')) return;
  const job = JSON.parse(readFileSync(join(slot, 'job.json'), 'utf8'));
  if (done.has(job.jobId)) return;
  done.add(job.jobId);
  const out = join(slot, 'result.json');
  writeFileSync(join(slot, 'canary-from-hostile-parser.txt'), 'HOSTILE-CANARY');
  switch (job.kind) {
    case 'pdf':
      symlinkSync('../ctl/heartbeat.json', out);
      break;
    case 'docx':
      execFileSync('mkfifo', [out]);
      break;
    case 'pptx':
      mkdirSync(out);
      break;
    case 'xlsx':
      atomic(out, Buffer.alloc(33 * 1024 * 1024, 0x20));
      break;
    case 'csv':
      atomic(out, JSON.stringify({ v: 1, jobId: 'f'.repeat(32), ok: false, code: 'internal' }));
      break;
    default:
      atomic(out, 'not json at all');
  }
  void existsSync;
}, 100);
