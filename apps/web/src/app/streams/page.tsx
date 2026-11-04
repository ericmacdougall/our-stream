// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { StreamsPanel } from '@/components/streams/StreamsPanel';
import { listItems } from '@/lib/api/lists';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('nav.streams')} · ${t('app.name')}` };

export default async function StreamsPage() {
  await requireMe('/streams');
  const api = await serverApi();
  const { data } = await api.GET('/v1/streams');
  return (
    <main id="main" className="page">
      <header className="masthead">
        <h1>{t('nav.streams')}</h1>
      </header>
      <StreamsPanel initial={listItems(data)} />
    </main>
  );
}
