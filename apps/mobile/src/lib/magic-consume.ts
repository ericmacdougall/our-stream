// SPDX-License-Identifier: Apache-2.0
// The magic-link consume / Switch / Keep decisions of the magic screen as plain functions (unit
// tested; the screen only renders the outcome). A link is honoured only when this device asked for
// one (stored, unexpired verifier) and the link names the server that request went to.
import type { ServerConfig } from './discovery';
import type { MagicLink } from './magic';
import { originOf } from './magic';
import { clearMagicVerifier, loadMagicVerifier, type MagicVerifier } from './magic-verifier';
import type { KeyValueStore } from './kv';

export type LinkCheck =
  { ok: true; request: MagicVerifier } | { ok: false; reason: 'no_request' | 'wrong_server' };

/** Local checks only: nothing is sent and nothing is deleted when a link is refused here. */
export function checkLink(link: MagicLink, request: MagicVerifier | null): LinkCheck {
  if (!request) return { ok: false, reason: 'no_request' };
  const expected = originOf(request.server.webUrl);
  if (!expected || link.server !== expected) return { ok: false, reason: 'wrong_server' };
  return { ok: true, request };
}

export type SignInResult<TMe> =
  { kind: 'ok'; secret: string; me: TMe } | { kind: 'refused' } | { kind: 'network' };

export interface ConsumeDeps<TMe extends { user: { id: string } }> {
  store: KeyValueStore;
  now?: () => number;
  allowLoopbackHttp?: boolean;
  /** POST /v1/auth/magic-link/consume with the token and verifier. */
  consume(server: ServerConfig, token: string, verifier: string): Promise<SignInResult<TMe>>;
  /** The user id of the current session, or null when signed out. */
  currentUserId: string | null;
}

export type ConsumeOutcome<TMe> =
  /** Not started on this device, expired, or for another server; nothing was sent. */
  | { kind: 'blocked'; reason: 'no_request' | 'wrong_server' }
  /** The server answered and refused; the verifier is deleted. */
  | { kind: 'refused' }
  /** The server was not reached; the verifier is kept so the same link can be retried. */
  | { kind: 'network' }
  | { kind: 'signedIn'; server: ServerConfig; secret: string; me: TMe; replacesSession: boolean }
  /** A session for a different account exists: the user chooses Switch or Keep. */
  | { kind: 'confirmSwitch'; server: ServerConfig; secret: string; me: TMe };

export async function consumeMagicLink<TMe extends { user: { id: string } }>(
  link: MagicLink,
  deps: ConsumeDeps<TMe>,
): Promise<ConsumeOutcome<TMe>> {
  const request = await loadMagicVerifier(deps.store, {
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.allowLoopbackHttp !== undefined ? { allowLoopbackHttp: deps.allowLoopbackHttp } : {}),
  });
  const check = checkLink(link, request);
  if (!check.ok) return { kind: 'blocked', reason: check.reason };
  const { server, verifier } = check.request;
  const result = await deps.consume(server, link.token, verifier);
  if (result.kind === 'network') return { kind: 'network' };
  // The server saw the token: whatever it answered, this request is spent.
  await clearMagicVerifier(deps.store);
  if (result.kind === 'refused') return { kind: 'refused' };
  if (deps.currentUserId !== null && deps.currentUserId !== result.me.user.id)
    return { kind: 'confirmSwitch', server, secret: result.secret, me: result.me };
  return {
    kind: 'signedIn',
    server,
    secret: result.secret,
    me: result.me,
    replacesSession: deps.currentUserId !== null,
  };
}

export interface SwitchDeps<TMe> {
  logoutCurrent(): Promise<void>;
  signIn(server: ServerConfig, secret: string, me: TMe): Promise<void>;
  /** Revokes the session the link created. */
  revokeIncoming(server: ServerConfig, secret: string): Promise<void>;
}

/** Switch: replace the current session with the link's. Keep: revoke the link's session instead. */
export async function resolveSwitch<TMe>(
  choice: 'switch' | 'keep',
  incoming: { server: ServerConfig; secret: string; me: TMe },
  deps: SwitchDeps<TMe>,
): Promise<void> {
  if (choice === 'switch') {
    await deps.logoutCurrent();
    await deps.signIn(incoming.server, incoming.secret, incoming.me);
  } else {
    await deps.revokeIncoming(incoming.server, incoming.secret);
  }
}
