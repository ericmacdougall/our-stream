// SPDX-License-Identifier: Apache-2.0
// Minimal key-value interface so the pure modules (session, pins, engagement) never import a
// storage backend. storage.ts provides the SecureStore and AsyncStorage implementations.

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory store for tests and for the web target's session-only fallback. */
export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & {
  dump(): Record<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
    dump() {
      return Object.fromEntries(data);
    },
  };
}
