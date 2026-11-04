// SPDX-License-Identifier: AGPL-3.0-only
import { notFound } from 'next/navigation';
import { PublishForm } from '@/components/publish/PublishForm';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';
import { t } from '@/lib/i18n';

export default async function PublishPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMe(`/content/${id}/publish`);
  const api = await serverApi();
  const [content, streams, members] = await Promise.all([
    api.GET('/v1/content/{id}', { params: { path: { id } } }),
    api.GET('/v1/streams'),
    api.GET('/v1/members'),
  ]);
  if (!content.data) notFound();
  return (
    <main id="main" className="page">
      <header className="masthead">
        <h1>{t('publish.title')}</h1>
      </header>
      <PublishForm
        content={content.data}
        streams={streams.data?.items ?? []}
        members={members.data?.items ?? []}
      />
    </main>
  );
}
