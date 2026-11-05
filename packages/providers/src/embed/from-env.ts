// SPDX-License-Identifier: AGPL-3.0-only
// Worker-side factory: EMBED_PROVIDER selects the adapter. The org policy is applied by the caller through
// selectProvider(policy, [provider], 'embed') with exactly one candidate (the pinned model): there is no
// fallback to another provider because vectors of two models must never share a pin.
import { DEFAULT_EMBED_MODEL, type EmbedProvider } from '../types.js';
import { createFakeEmbed } from './fake.js';
import { createQwenHttpEmbed } from './qwen-http.js';

export type EmbedProviderName = 'fake' | 'qwen-http';

export function createEmbedProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  prefix = 'EMBED',
): EmbedProvider {
  const name = (env[`${prefix}_PROVIDER`] ?? 'fake') as EmbedProviderName;
  const model = env[`${prefix}_MODEL`] ?? DEFAULT_EMBED_MODEL;
  switch (name) {
    case 'fake':
      return createFakeEmbed({ model });
    case 'qwen-http': {
      const timeoutRaw = env[`${prefix}_TIMEOUT_MS`];
      const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
      if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0))
        throw new Error(`${prefix}_TIMEOUT_MS must be a positive number of milliseconds`);
      return createQwenHttpEmbed({
        baseUrl: env[`${prefix}_URL`] ?? 'http://embeddings:80',
        model,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    }
    default:
      throw new Error(`${prefix}_PROVIDER must be one of fake, qwen-http (got ${String(name)})`);
  }
}
