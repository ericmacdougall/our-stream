// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False during server render and hydration, true afterwards in the browser. Zone- and
 * locale-dependent text must render from this so the server's zone never stays on screen
 * (suppressHydrationWarning keeps the server text, it does not repair it).
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
