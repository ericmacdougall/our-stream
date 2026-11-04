// SPDX-License-Identifier: AGPL-3.0-only
// Worker readiness for probes (Helm, compose): a tiny HTTP endpoint on a loopback port by default
// (HOST honoured like the API) reporting whether pg-boss started and when the outbox was last drained.
// No tenant data and no inputs: the only route is GET /health.
import { createServer, type Server } from 'node:http';

export interface WorkerHealthState {
  startedAt: Date;
  bossStarted: boolean;
  lastDrainAt: Date | null;
  lastDrainOk: boolean | null;
  drainIntervalMs: number;
}

export interface WorkerHealth {
  status: 'ok' | 'degraded';
  bossStarted: boolean;
  lastDrainAt: string | null;
  lastDrainOk: boolean | null;
  uptimeSeconds: number;
}

/** Degraded when pg-boss is not up, the last drain failed, or no drain completed within 3 intervals (after a start-up grace of one minute). */
export function workerHealth(state: WorkerHealthState, now: Date): WorkerHealth {
  const uptimeMs = now.getTime() - state.startedAt.getTime();
  const graceMs = Math.max(60_000, 3 * state.drainIntervalMs);
  const stale =
    state.lastDrainAt === null
      ? uptimeMs > graceMs
      : now.getTime() - state.lastDrainAt.getTime() > 3 * state.drainIntervalMs;
  const ok = state.bossStarted && state.lastDrainOk !== false && !stale;
  return {
    status: ok ? 'ok' : 'degraded',
    bossStarted: state.bossStarted,
    lastDrainAt: state.lastDrainAt?.toISOString() ?? null,
    lastDrainOk: state.lastDrainOk,
    uptimeSeconds: Math.floor(uptimeMs / 1000),
  };
}

export function startHealthServer(
  state: WorkerHealthState,
  opts: { host: string; port: number; now: () => Date },
): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/health' && req.url !== '/health/')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
      return;
    }
    const body = workerHealth(state, opts.now());
    res
      .writeHead(body.status === 'ok' ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      .end(JSON.stringify(body));
  });
  server.listen(opts.port, opts.host);
  return server;
}
