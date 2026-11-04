// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { browserApi } from '@/lib/api/client';
import { clearAllCaches } from '@/lib/caches';
import { t } from '@/lib/i18n';
import { useSession } from './SessionProvider';

const UNREAD_POLL_MS = 60_000;

export function NavBar() {
  const me = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState<number | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const refreshUnread = useCallback(async () => {
    try {
      const { data } = await browserApi().GET('/v1/notifications');
      if (data) setUnread(data.unread);
    } catch {
      // Keep the last known count; the badge is advisory.
    }
  }, []);

  useEffect(() => {
    if (!me) return;
    void refreshUnread();
    const id = setInterval(() => void refreshUnread(), UNREAD_POLL_MS);
    const onFocus = () => void refreshUnread();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [me, refreshUnread, pathname]);

  if (!me) return null;

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await browserApi().POST('/v1/auth/logout');
    } finally {
      await clearAllCaches();
      router.push('/sign-in');
      router.refresh();
    }
  }

  const links: { href: string; label: string }[] = [
    { href: '/', label: t('nav.feed') },
    { href: '/streams', label: t('nav.streams') },
    { href: '/upload', label: t('nav.upload') },
  ];

  return (
    <header className="topnav">
      <nav aria-label={t('nav.primary')} className="topnav-inner">
        <Link href="/" className="brand">
          <span className="brand-org">{me.org?.name ?? t('app.name')}</span>
        </Link>
        <ul className="topnav-links">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} aria-current={pathname === l.href ? 'page' : undefined}>
                {l.label}
              </Link>
            </li>
          ))}
          <li>
            <Link
              href="/notifications"
              aria-current={pathname === '/notifications' ? 'page' : undefined}
              aria-label={
                unread ? t('nav.notificationsWithCount', { count: unread }) : t('nav.notifications')
              }
            >
              {t('nav.notifications')}
              {unread ? (
                <span className="badge" data-testid="unread-badge" aria-hidden="true">
                  {unread}
                </span>
              ) : null}
            </Link>
          </li>
        </ul>
        <div className="topnav-user">
          <span className="muted">{me.user.displayName}</span>
          <button type="button" onClick={() => void signOut()} disabled={signingOut}>
            {t('nav.signOut')}
          </button>
        </div>
      </nav>
    </header>
  );
}
