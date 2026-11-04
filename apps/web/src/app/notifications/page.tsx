// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { NotificationsList } from '@/components/notifications/NotificationsList';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('nav.notifications')} · ${t('app.name')}` };

export default async function NotificationsPage() {
  await requireMe('/notifications');
  const api = await serverApi();
  const { data } = await api.GET('/v1/notifications');
  return (
    <main id="main" className="page">
      <header className="masthead">
        <h1>{t('nav.notifications')}</h1>
      </header>
      <NotificationsList initial={data?.items ?? []} unread={data?.unread ?? 0} />
    </main>
  );
}
