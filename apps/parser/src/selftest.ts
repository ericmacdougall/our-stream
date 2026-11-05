// SPDX-License-Identifier: AGPL-3.0-only
// Start-up self-test, identical under compose (`network_mode: none`) and Kubernetes (deny-all NetworkPolicy).
// It is a misconfiguration check only: a compromised parser can lie about it, which is why the worker trusts
// nothing from the parser beyond the validated output schema.
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import type { Heartbeat } from '@our-stream/documents';

type SelfTest = Heartbeat['selfTest'];

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const finish = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

/** True when an outbound connection or a DNS lookup succeeds (the sandbox is NOT isolated). */
export async function networkIsOpen(timeoutMs = 1500): Promise<boolean> {
  const targets: [string, number][] = [
    ['1.1.1.1', 443],
    ['9.9.9.9', 53],
    ['8.8.8.8', 53],
  ];
  const results = await Promise.all(targets.map(([h, p]) => tryConnect(h, p, timeoutMs)));
  if (results.some(Boolean)) return true;
  try {
    await Promise.race([
      lookup('example.com'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export function rootIsReadOnly(mountInfo: string): boolean {
  for (const line of mountInfo.split('\n')) {
    const f = line.split(' ');
    if (f[4] === '/') return (f[5] ?? '').split(',').includes('ro');
  }
  return false;
}

const SECRET_ENV = /(PASSWORD|SECRET|TOKEN|DATABASE|S3_|ACCESS_KEY|API_KEY|CREDENTIAL)/i;

export async function runSelfTest(env: NodeJS.ProcessEnv = process.env): Promise<SelfTest> {
  let rootfs: SelfTest['rootfs'] = 'writable';
  try {
    if (rootIsReadOnly(readFileSync('/proc/self/mountinfo', 'utf8'))) rootfs = 'readonly';
  } catch {
    /* not Linux: stays 'writable', so the worker refuses */
  }
  const network: SelfTest['network'] = (await networkIsOpen()) ? 'open' : 'blocked';
  const nonRoot = typeof process.getuid === 'function' ? process.getuid() !== 0 : false;
  const noSecretEnv = !Object.keys(env).some((k) => SECRET_ENV.test(k));
  return {
    ok: network === 'blocked' && rootfs === 'readonly' && nonRoot && noSecretEnv,
    network,
    rootfs,
    nonRoot,
    noSecretEnv,
  };
}
