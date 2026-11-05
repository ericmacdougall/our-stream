// SPDX-License-Identifier: Apache-2.0
// Device binding for magic links (PKCE-style, docs/api.md). Before asking for a link the app makes a
// random verifier, keeps it in the secure store with the server it was requested from, and sends
// only base64url(SHA-256(verifier)) as `clientChallenge`. The link is then consumable only by a
// request that presents the verifier, so a link opened on another device or crafted by someone else
// cannot sign this app in. Pure over a KeyValueStore and injected crypto so it is unit-tested.
import { validateServerUrl, type ServerConfig } from './discovery';
import type { KeyValueStore } from './kv';

const KEY = 'os.magicVerifier';
/** Mirrors the API default MAGIC_LINK_TTL_MINUTES (apps/api/src/config.ts): a verifier outlives no link. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const VERIFIER_BYTES = 32;

export interface MagicCrypto {
  randomBytes(length: number): Uint8Array | Promise<Uint8Array>;
  sha256(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface MagicVerifier {
  verifier: string;
  server: ServerConfig;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding (RFC 4648 section 5). */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += ALPHABET[b0 >> 2]! + ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]!;
    if (i + 1 < bytes.length) out += ALPHABET[((b1 & 15) << 2) | (b2 >> 6)]!;
    if (i + 2 < bytes.length) out += ALPHABET[b2 & 63]!;
  }
  return out;
}

/** The verifier is base64url, so ASCII: its UTF-8 bytes are its char codes. */
function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

export async function challengeOf(verifier: string, crypto: MagicCrypto): Promise<string> {
  return base64url(await crypto.sha256(asciiBytes(verifier)));
}

/** Creates and stores a fresh verifier for `server`; returns the challenge to send. Replaces any earlier one. */
export async function startMagicRequest(
  store: KeyValueStore,
  server: ServerConfig,
  crypto: MagicCrypto,
  now: () => number = Date.now,
): Promise<{ clientChallenge: string }> {
  const verifier = base64url(await crypto.randomBytes(VERIFIER_BYTES));
  await store.set(KEY, JSON.stringify({ verifier, server, at: now() }));
  return { clientChallenge: await challengeOf(verifier, crypto) };
}

/** The stored verifier, or null when none, corrupt, or older than the link TTL (it is then deleted). */
export async function loadMagicVerifier(
  store: KeyValueStore,
  opts: { now?: () => number; allowLoopbackHttp?: boolean } = {},
): Promise<MagicVerifier | null> {
  const now = opts.now ?? Date.now;
  let raw: string | null;
  try {
    raw = await store.get(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as {
      verifier?: unknown;
      server?: Partial<ServerConfig>;
      at?: unknown;
    };
    const allow = opts.allowLoopbackHttp ?? false;
    const apiUrl =
      typeof v.server?.apiUrl === 'string'
        ? validateServerUrl(v.server.apiUrl, { allowLoopbackHttp: allow })
        : null;
    const webUrl =
      typeof v.server?.webUrl === 'string'
        ? validateServerUrl(v.server.webUrl, { allowLoopbackHttp: allow })
        : null;
    const fresh = typeof v.at === 'number' && now() - v.at >= 0 && now() - v.at < MAGIC_LINK_TTL_MS;
    if (
      typeof v.verifier === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(v.verifier) &&
      apiUrl &&
      webUrl &&
      fresh
    )
      return { verifier: v.verifier, server: { apiUrl, webUrl } };
  } catch {
    // Corrupt value: fall through and delete it.
  }
  await store.remove(KEY);
  return null;
}

export async function clearMagicVerifier(store: KeyValueStore): Promise<void> {
  await store.remove(KEY);
}
