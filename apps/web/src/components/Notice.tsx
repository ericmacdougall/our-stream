// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';

/** Status/error text announced to assistive technology without stealing focus. */
export function Notice({
  kind = 'info',
  children,
  id,
}: {
  kind?: 'info' | 'error' | 'success';
  children: ReactNode;
  id?: string;
}) {
  if (!children) return null;
  return (
    <p
      id={id}
      className={`notice notice-${kind}`}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
    >
      {children}
    </p>
  );
}
