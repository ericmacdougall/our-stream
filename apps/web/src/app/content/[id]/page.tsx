// SPDX-License-Identifier: AGPL-3.0-only
import { notFound } from 'next/navigation';
import { ContentPanel } from '@/components/content/ContentPanel';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';

export default async function ContentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMe(`/content/${id}`);
  const api = await serverApi();
  const { data } = await api.GET('/v1/content/{id}', { params: { path: { id } } });
  if (!data) notFound();
  return (
    <main id="main" className="page">
      <ContentPanel initial={data} />
    </main>
  );
}
