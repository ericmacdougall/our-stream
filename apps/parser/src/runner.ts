// SPDX-License-Identifier: AGPL-3.0-only
// Runs one extraction in a worker thread with a V8 heap cap and a wall clock. The service itself never
// parses: a runaway or crashing parser kills only the thread, and the service stays up for the next job.
// (A native out-of-memory beyond the heap cap is the container cgroup's job; see docs/documents.md.)
import { Worker } from 'node:worker_threads';
import type { JobFile, ParseLimits } from '@our-stream/documents';
import type { ExtractResult } from './extract.js';

const DEFAULT_ENTRY = new URL('./extract-thread.js', import.meta.url);

export function runExtraction(
  inputPath: string,
  job: JobFile,
  limits: ParseLimits,
  entry: URL = DEFAULT_ENTRY,
): Promise<ExtractResult> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(entry, {
      workerData: { inputPath, job, limits },
      env: {}, // the thread sees no environment at all
      resourceLimits: {
        maxOldGenerationSizeMb: limits.heapMb,
        maxYoungGenerationSizeMb: Math.min(64, Math.max(8, Math.floor(limits.heapMb / 8))),
        stackSizeMb: 4,
      },
    });
    const done = (r: ExtractResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, code: 'wall_time' }), limits.wallMs);
    worker.once('message', (m: ExtractResult) => done(m));
    worker.once('error', (err: Error & { code?: string }) =>
      done({ ok: false, code: err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'internal' }),
    );
    worker.once('exit', () => done({ ok: false, code: 'internal' }));
  });
}
