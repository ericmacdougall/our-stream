// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Holds the signed-in user for client components, keeps the CSRF token in memory for mutations,
// and registers the service worker (static assets only, ADR-0004).
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { Me } from '@/lib/api/server';
import { setCsrfToken } from '@/lib/api/client';

const SessionContext = createContext<Me | null>(null);

export function useSession(): Me | null {
  return useContext(SessionContext);
}

export function SessionProvider({ me, children }: { me: Me | null; children: ReactNode }) {
  // Effect only: during server rendering this module is shared by every request, so the token
  // must never be written there.
  useEffect(() => {
    setCsrfToken(me?.csrfToken ?? null);
    return () => setCsrfToken(null);
  }, [me]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production' && process.env['NEXT_PUBLIC_ENABLE_SW'] !== '1') {
      return;
    }
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Offline shell is a progressive enhancement; the app works without it.
    });
  }, []);

  return <SessionContext.Provider value={me}>{children}</SessionContext.Provider>;
}
