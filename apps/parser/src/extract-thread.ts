// SPDX-License-Identifier: AGPL-3.0-only
// Entry of the extraction thread (see runner.ts). Receives {inputPath, job, limits}, posts one ExtractResult.
import { parentPort, workerData } from 'node:worker_threads';
import type { JobFile, ParseLimits } from '@our-stream/documents';
import { extractFile } from './extract.js';

const data = workerData as { inputPath: string; job: JobFile; limits: ParseLimits };
const result = await extractFile(data.inputPath, data.job, data.limits);
parentPort?.postMessage(result);
