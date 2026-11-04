// SPDX-License-Identifier: AGPL-3.0-only
// Worker-side factory: ASR_PROVIDER selects the adapter; the org policy is applied by the caller
// through selectProvider() so a misconfigured deployment refuses rather than degrades.
import type { AsrProvider } from '../types.js';
import { createFakeAsr } from './fake.js';
import { createWhisperHttpAsr } from './whisper-http.js';

export type AsrProviderName = 'fake' | 'whisper-http';

export function createAsrProviderFromEnv(env: NodeJS.ProcessEnv = process.env): AsrProvider {
  const name = (env['ASR_PROVIDER'] ?? 'fake') as AsrProviderName;
  switch (name) {
    case 'fake':
      return createFakeAsr();
    case 'whisper-http': {
      const timeoutRaw = env['WHISPER_TIMEOUT_MS'];
      const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
      if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0))
        throw new Error('WHISPER_TIMEOUT_MS must be a positive number of milliseconds');
      return createWhisperHttpAsr({
        baseUrl: env['WHISPER_URL'] ?? 'http://whisper:8080',
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    }
    default:
      throw new Error(`ASR_PROVIDER must be one of fake, whisper-http (got ${String(name)})`);
  }
}
