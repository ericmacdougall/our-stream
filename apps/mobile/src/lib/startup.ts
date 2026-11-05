// SPDX-License-Identifier: Apache-2.0
// Session startup as a plain function so every branch is unit-tested (session-context.tsx only
// applies the result). Every path ends in `signedIn` or `signedOut`; none leaves the app loading.
export interface StartupDeps<TStored, TMe> {
  /** The stored session, or null when nothing (valid) is stored. */
  load(): Promise<TStored | null>;
  /** Validates the stored session with GET /v1/me. A thrown error means the server was unreachable. */
  fetchMe(stored: TStored): Promise<{ data?: TMe | undefined; status: number }>;
  notices: { sessionExpired: string; generic: string; offline: string };
}

export type StartupResult<TStored, TMe> =
  | { kind: 'signedIn'; stored: TStored; me: TMe }
  /** `drop` clears the stored session (it is useless); otherwise it is kept for the next launch. */
  | { kind: 'signedOut'; notice: string | null; drop: boolean };

export async function resolveStartup<TStored, TMe>(
  deps: StartupDeps<TStored, TMe>,
): Promise<StartupResult<TStored, TMe>> {
  const stored = await deps.load();
  if (!stored) return { kind: 'signedOut', notice: null, drop: false };
  let res: { data?: TMe | undefined; status: number };
  try {
    res = await deps.fetchMe(stored);
  } catch {
    return { kind: 'signedOut', notice: deps.notices.offline, drop: false };
  }
  if (res.data) return { kind: 'signedIn', stored, me: res.data };
  // The API hooks only clear the session for 401 and 403 `not_member`; any other 401/403 (a proxy,
  // a WAF, an unknown code, a body that is not JSON) must drop the session here or the app would
  // stay on the loading screen.
  if (res.status === 401 || res.status === 403)
    return { kind: 'signedOut', notice: deps.notices.sessionExpired, drop: true };
  return { kind: 'signedOut', notice: deps.notices.generic, drop: false };
}
