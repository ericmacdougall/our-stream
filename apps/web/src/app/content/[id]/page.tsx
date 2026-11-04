// SPDX-License-Identifier: AGPL-3.0-only
import { notFound } from 'next/navigation';
import { ContentPanel } from '@/components/content/ContentPanel';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';

export default async function ContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  await requireMe(`/content/${id}`);
  const api = await serverApi();
  const [{ data }, query] = await Promise.all([
    api.GET('/v1/content/{id}', { params: { path: { id } } }),
    searchParams,
  ]);
  if (!data) notFound();
  // ?t=<ms> opens the player at that instant (search deep links, share links); invalid values ignored.
  const rawT = Array.isArray(query['t']) ? query['t'][0] : query['t'];
  const tMs = rawT !== undefined && /^\d{1,12}$/.test(rawT) ? Number(rawT) : null;
  return (
    <main id="main" className="page">
      <ContentPanel initial={data} tMs={tMs} />
    </main>
  );
}
