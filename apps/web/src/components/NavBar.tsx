// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { browserApi, errorCode } from '@/lib/api/client';
import { clearAllCaches } from '@/lib/caches';
import { errorMessage } from '@/lib/errors';
import { clearDrafts } from '@/lib/m1b/comments';
import { t } from '@/lib/i18n';
import { useSession } from './SessionProvider';

const UNREAD_POLL_MS = 60_000;

export function NavBar() {
  const me = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState<number | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

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
    setSignOutFailed(false);
    // Navigate only when the server really ended the session: /sign-in now bounces a still-valid
    // session straight back to the feed, which on a shared machine would look like a sign-out.
    let ended: boolean;
    let csrfRefused = false;
    try {
      const result = await browserApi().POST('/v1/auth/logout');
      ended = result.response.status === 401 || errorMessage(result) === null;
      csrfRefused = !ended && errorCode(result.error) === 'csrf';
    } catch {
      ended = false;
    }
    if (!ended) {
      setSignOutFailed(true);
      setSigningOut(false);
      // A refused CSRF token (rotated in another tab) is recovered by re-rendering the layout, which
      // hands SessionProvider the current token for the next attempt.
      if (csrfRefused) router.refresh();
      return;
    }
    await clearAllCaches();
    // Unsent comment drafts belong to this person: never leave them for the next sign-in.
    try {
      clearDrafts(sessionStorage);
    } catch {
      // Storage unavailable: nothing persisted to clear.
    }
    router.push('/sign-in');
    router.refresh();
  }

  const links: { href: string; label: string }[] = [
    { href: '/', label: t('nav.feed') },
    { href: '/streams', label: t('nav.streams') },
    { href: '/upload', label: t('nav.upload') },
  ];
  if (me.org?.role === 'owner' || me.org?.role === 'admin') {
    links.push({ href: '/org/settings', label: t('nav.orgSettings') });
  }

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
            {/* The accessible name is the visible text plus hidden "unread", so label-in-name
                (WCAG 2.5.3) holds whatever the count: "Notifications 3 unread". */}
            <Link
              href="/notifications"
              aria-current={pathname === '/notifications' ? 'page' : undefined}
            >
              {t('nav.notifications')}
              {unread ? (
                <>
                  {' '}
                  <span className="badge" data-testid="unread-badge">
                    {unread}
                  </span>
                  <span className="visually-hidden"> {t('nav.unread', { count: unread })}</span>
                </>
              ) : null}
            </Link>
          </li>
        </ul>
        {/* Plain GET form: the query lands in the URL of /search, never in any client log. */}
        <form
          role="search"
          action="/search"
          method="get"
          className="topnav-search"
          data-shortcuts-off="true"
        >
          <label htmlFor="nav-search" className="visually-hidden">
            {t('nav.search')}
          </label>
          <input
            id="nav-search"
            name="q"
            type="search"
            maxLength={200}
            placeholder={t('nav.searchPlaceholder')}
            autoComplete="off"
          />
          <button type="submit">{t('nav.search')}</button>
        </form>
        <div className="topnav-user">
          <Link href="/account" aria-current={pathname === '/account' ? 'page' : undefined}>
            <span className="visually-hidden">{t('nav.account')}: </span>
            {me.user.displayName}
          </Link>
          <button type="button" onClick={() => void signOut()} disabled={signingOut}>
            {t('nav.signOut')}
          </button>
          {signOutFailed ? (
            <span role="alert" className="notice notice-error" data-testid="sign-out-failed">
              {t('nav.signOutFailed')}
            </span>
          ) : null}
        </div>
      </nav>
    </header>
  );
}
