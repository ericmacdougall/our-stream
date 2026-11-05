// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Mobile sign-in handoff (`/magic?token=<T>&app=1`). Never calls the API: the token is only passed
// on to the app through a custom-scheme link the person presses, so mail scanners and previews cannot
// burn it. The token is not displayed or logged. The server origin is read after mount because the
// page may be reached through any hostname.
import Link from 'next/link';
import { buildAppLink, isHandoffToken } from '@/lib/magic-handoff';
import { t } from '@/lib/i18n';
import { useMounted } from '@/lib/useMounted';
import { Notice } from '../Notice';

export function MagicHandoff({ token }: { token: string | null }) {
  const mounted = useMounted();

  if (!isHandoffToken(token)) {
    return (
      <div className="card">
        <h1>{t('auth.magic.title')}</h1>
        <Notice kind="error">{t('auth.magic.missing')}</Notice>
        <p>
          <Link href="/sign-in">{t('auth.signIn.link')}</Link>
        </p>
      </div>
    );
  }

  const href = mounted ? buildAppLink(token, window.location.origin) : null;

  return (
    <div className="card">
      <h1>{t('auth.magic.app.title')}</h1>
      <p>{t('auth.magic.app.intro')}</p>
      <div className="actions">
        {href ? (
          <a className="button primary" href={href} data-testid="open-in-app">
            {t('auth.magic.app.open')}
          </a>
        ) : (
          <button type="button" className="primary" disabled>
            {t('auth.magic.app.open')}
          </button>
        )}
      </div>
      <p>{t('auth.magic.app.note')}</p>
    </div>
  );
}
