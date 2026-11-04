// SPDX-License-Identifier: AGPL-3.0-only
import 'server-only';
import { redirect } from 'next/navigation';
import { getMe, type Me } from './server';

/** Server-side gate: the real session check (ADR-0011); proxy.ts only looks at cookie presence. */
export async function requireMe(nextPath?: string): Promise<Me> {
  const me = await getMe();
  if (!me) redirect(nextPath ? `/sign-in?next=${encodeURIComponent(nextPath)}` : '/sign-in');
  return me;
}
