// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { startHealthServer, workerHealth, type WorkerHealthState } from './health.js';

const t0 = new Date('2026-11-04T08:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const base: WorkerHealthState = {
  startedAt: t0,
  bossStarted: true,
  lastDrainAt: null,
  lastDrainOk: null,
  drainIntervalMs: 5000,
};

describe('worker health', () => {
  it('is ok during the start-up grace, degraded once drains stop or fail or pg-boss is down', () => {
    expect(workerHealth(base, at(10_000)).status).toBe('ok');
    expect(workerHealth(base, at(61_000)).status).toBe('degraded'); // never drained after the grace
    const drained = { ...base, lastDrainAt: at(50_000), lastDrainOk: true };
    expect(workerHealth(drained, at(60_000)).status).toBe('ok');
    expect(workerHealth(drained, at(66_000)).status).toBe('degraded'); // > 3 intervals since the last drain
    expect(workerHealth({ ...drained, lastDrainOk: false }, at(52_000)).status).toBe('degraded');
    expect(workerHealth({ ...drained, bossStarted: false }, at(52_000)).status).toBe('degraded');
    expect(workerHealth(drained, at(60_000))).toMatchObject({
      lastDrainAt: '2026-11-04T08:00:50.000Z',
      uptimeSeconds: 60,
    });
  });

  it('serves GET /health on the given host and port only', async () => {
    const state = { ...base, lastDrainAt: at(1000), lastDrainOk: true };
    const server = startHealthServer(state, { host: '127.0.0.1', port: 0, now: () => at(2000) });
    await new Promise((resolve) => server.once('listening', resolve));
    const addr = server.address() as { port: number };
    const ok = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toMatchObject({ status: 'ok', bossStarted: true });
    expect((await fetch(`http://127.0.0.1:${addr.port}/other`)).status).toBe(404);
    state.lastDrainOk = false;
    expect((await fetch(`http://127.0.0.1:${addr.port}/health`)).status).toBe(503);
    await new Promise((resolve) => server.close(resolve));
  });
});
