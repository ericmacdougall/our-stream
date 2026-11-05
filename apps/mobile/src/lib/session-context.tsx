// SPDX-License-Identifier: Apache-2.0
// Session provider: loads the stored session, builds the typed client bound to the pinned server
// and the bearer secret, validates it with GET /v1/me, and signs out on 401 / not_member. The secret
// never leaves the provider except as the Authorization header the client sets.
import type { ApiClient, MeM1b } from '@our-stream/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { z } from 'zod';
import { createApi, logoutBestEffort } from './api';
import type { ServerConfig } from './discovery';
import { ALLOW_LOOPBACK_HTTP } from './runtime';
import {
  clearSession,
  loadSession,
  saveLastServer,
  saveSession,
  type StoredSession,
} from './session';
import { resolveStartup } from './startup';
import { secureStore } from './storage';
import { strings } from '../i18n';

export type Me = z.output<typeof MeM1b>;

export type SessionState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; server: ServerConfig; api: ApiClient; me: Me };

interface SessionContextValue {
  state: SessionState;
  /** Message explaining an involuntary sign-out, shown once on the sign-in screen. */
  notice: string | null;
  clearNotice(): void;
  signIn(server: ServerConfig, secret: string, me: Me): Promise<void>;
  signOut(): Promise<void>;
  refreshMe(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider(props: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  // The current client, for the 401/403 hooks to compare against (a stale client's 401 is ignored).
  const current = useRef<ApiClient | null>(null);

  const dropLocal = useCallback(async (message: string | null) => {
    current.current = null;
    await clearSession(secureStore);
    setNotice(message);
    setState({ status: 'signedOut' });
  }, []);

  const build = useCallback(
    (server: ServerConfig, secret: string): ApiClient => {
      let api: ApiClient | null = null;
      api = createApi({
        apiUrl: server.apiUrl,
        secret,
        onUnauthorized: () => {
          if (current.current === api) void dropLocal(strings.errors.sessionExpired);
        },
        onForbidden: () => {
          if (current.current === api) void dropLocal(strings.errors.forbidden);
        },
      });
      current.current = api;
      return api;
    },
    [dropLocal],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await resolveStartup<StoredSession & { api: ApiClient }, Me>({
        load: async () => {
          const stored = await loadSession(secureStore, { allowLoopbackHttp: ALLOW_LOOPBACK_HTTP });
          return stored ? { ...stored, api: build(stored.server, stored.secret) } : null;
        },
        fetchMe: async (stored) => {
          const { data, response } = await stored.api.GET('/v1/me');
          return { data: data as Me | undefined, status: response.status };
        },
        notices: {
          sessionExpired: strings.errors.sessionExpired,
          generic: strings.errors.generic,
          offline: strings.errors.offline,
        },
      });
      if (!live) return;
      if (result.kind === 'signedIn') {
        setState({
          status: 'signedIn',
          server: result.stored.server,
          api: result.stored.api,
          me: result.me,
        });
      } else if (result.drop) {
        await dropLocal(result.notice);
      } else {
        setState({ status: 'signedOut' });
        setNotice(result.notice);
      }
    })();
    return () => {
      live = false;
    };
  }, [build, dropLocal]);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      notice,
      clearNotice: () => setNotice(null),
      async signIn(server, secret, me) {
        await saveSession(secureStore, { server, secret });
        await saveLastServer(secureStore, server);
        const api = build(server, secret);
        setNotice(null);
        setState({ status: 'signedIn', server, api, me });
      },
      async signOut() {
        if (state.status === 'signedIn') await logoutBestEffort(state.api);
        await dropLocal(null);
      },
      async refreshMe() {
        if (state.status !== 'signedIn') return;
        const { data } = await state.api.GET('/v1/me');
        if (data) setState({ ...state, me: data as Me });
      },
    }),
    [state, notice, build, dropLocal],
  );

  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

/** For screens that only render when signed in. */
export function useSignedIn(): Extract<SessionState, { status: 'signedIn' }> {
  const { state } = useSession();
  if (state.status !== 'signedIn') throw new Error('not signed in');
  return state;
}
