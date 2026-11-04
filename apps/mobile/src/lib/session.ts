// SPDX-License-Identifier: Apache-2.0
// Persistence of the pinned servers and the signed-in session over a KeyValueStore. The caller
// passes the secure store (storage.ts); nothing here logs or returns values beyond what is asked.
import { validateServerUrl, type ServerConfig } from './discovery';
import type { KeyValueStore } from './kv';

const PINS_KEY = 'os.pins';
const SERVER_KEY = 'os.server';
const SESSION_KEY = 'os.session';
const LAST_SERVER_KEY = 'os.lastServer';

export interface StoredSession {
  server: ServerConfig;
  /** The bearer session value from `AuthResponse.sessionToken`. */
  secret: string;
}

function parseServer(value: unknown, allowLoopbackHttp: boolean): ServerConfig | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { apiUrl?: unknown; webUrl?: unknown };
  if (typeof v.apiUrl !== 'string' || typeof v.webUrl !== 'string') return null;
  const apiUrl = validateServerUrl(v.apiUrl, { allowLoopbackHttp });
  const webUrl = validateServerUrl(v.webUrl, { allowLoopbackHttp });
  return apiUrl && webUrl ? { apiUrl, webUrl } : null;
}

async function readPins(store: KeyValueStore): Promise<Record<string, unknown>> {
  try {
    const raw = await store.get(PINS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function pinnedServer(
  store: KeyValueStore,
  domain: string,
  opts: { allowLoopbackHttp?: boolean } = {},
): Promise<ServerConfig | null> {
  const pins = await readPins(store);
  return parseServer(pins[domain], opts.allowLoopbackHttp ?? false);
}

export async function pinServer(
  store: KeyValueStore,
  domain: string,
  server: ServerConfig,
): Promise<void> {
  const pins = await readPins(store);
  pins[domain] = server;
  await store.set(PINS_KEY, JSON.stringify(pins));
}

export async function unpinServer(store: KeyValueStore, domain: string): Promise<void> {
  const pins = await readPins(store);
  delete pins[domain];
  await store.set(PINS_KEY, JSON.stringify(pins));
}

export async function saveSession(store: KeyValueStore, session: StoredSession): Promise<void> {
  await store.set(SERVER_KEY, JSON.stringify(session.server));
  await store.set(SESSION_KEY, session.secret);
}

export async function loadSession(
  store: KeyValueStore,
  opts: { allowLoopbackHttp?: boolean } = {},
): Promise<StoredSession | null> {
  const [serverRaw, secret] = await Promise.all([store.get(SERVER_KEY), store.get(SESSION_KEY)]);
  if (!serverRaw || !secret) return null;
  try {
    const server = parseServer(JSON.parse(serverRaw), opts.allowLoopbackHttp ?? false);
    return server ? { server, secret } : null;
  } catch {
    return null;
  }
}

/** The server most recently confirmed or signed in to: the one a magic link is consumed against. */
export async function saveLastServer(store: KeyValueStore, server: ServerConfig): Promise<void> {
  await store.set(LAST_SERVER_KEY, JSON.stringify(server));
}

export async function loadLastServer(
  store: KeyValueStore,
  opts: { allowLoopbackHttp?: boolean } = {},
): Promise<ServerConfig | null> {
  try {
    const raw = await store.get(LAST_SERVER_KEY);
    return raw ? parseServer(JSON.parse(raw), opts.allowLoopbackHttp ?? false) : null;
  } catch {
    return null;
  }
}

/** Sign-out: removes the session but keeps the pinned servers. */
export async function clearSession(store: KeyValueStore): Promise<void> {
  await store.remove(SESSION_KEY);
  await store.remove(SERVER_KEY);
}
