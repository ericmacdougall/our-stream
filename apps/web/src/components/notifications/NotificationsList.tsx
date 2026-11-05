// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { z } from 'zod';
import type { Notification } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';
import { t } from '@/lib/i18n';
import { useMounted } from '@/lib/useMounted';
import { Notice } from '../Notice';

type NotificationT = z.output<typeof Notification>;

/** Copy per notification kind; a null title means the recipient may no longer see the content. */
function describe(n: NotificationT): string {
  if (n.kind === 'content.retracted') return t('notifications.retracted');
  if (n.kind === 'content.published') {
    return n.title
      ? t('notifications.published', { title: n.title })
      : t('notifications.publishedNeutral');
  }
  return n.title
    ? t('notifications.generic', { title: n.title })
    : t('notifications.genericNeutral');
}

export function NotificationsList({
  initial,
  unread: initialUnread,
}: {
  initial: NotificationT[];
  unread: number;
}) {
  const [items, setItems] = useState(initial);
  const [unread, setUnread] = useState(initialUnread);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useMounted();
  const formatter = new Intl.DateTimeFormat(mounted ? undefined : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(mounted ? {} : { timeZone: 'UTC' }),
  });

  async function markRead(id: string) {
    if (pending) return;
    setPending(id);
    setError(null);
    try {
      const result = await browserApi().POST('/v1/notifications/{id}/read', {
        params: { path: { id } },
      });
      if (result.error) {
        setError(t('error.generic'));
        return;
      }
      const now = new Date().toISOString();
      setItems((list) => list.map((n) => (n.id === id ? { ...n, readAt: now } : n)));
      setUnread((u) => Math.max(0, u - 1));
    } catch {
      setError(t('error.network'));
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="notifications-heading" className="card">
      <h2 id="notifications-heading">{t('notifications.unreadCount', { count: unread })}</h2>
      <Notice kind="error">{error}</Notice>
      {items.length === 0 ? (
        <p className="muted">{t('notifications.empty')}</p>
      ) : (
        <ul className="list notifications" data-testid="notifications-list">
          {items.map((n) => (
            <li key={n.id} className={n.readAt ? 'read' : 'unread'}>
              <div>
                <p>
                  {n.contentId && n.title ? (
                    <Link href={`/content/${n.contentId}`}>{describe(n)}</Link>
                  ) : (
                    describe(n)
                  )}
                </p>
                <small className="muted">
                  <time dateTime={n.createdAt}>
                    {formatter.format(new Date(n.createdAt))}
                    {mounted ? '' : ' UTC'}
                  </time>
                  {n.readAt ? ` · ${t('notifications.read')}` : ''}
                </small>
              </div>
              {!n.readAt ? (
                <button
                  type="button"
                  onClick={() => void markRead(n.id)}
                  disabled={pending !== null}
                  aria-label={t('notifications.markReadLabel', { what: describe(n) })}
                >
                  {t('notifications.markRead')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
