// SPDX-License-Identifier: AGPL-3.0-only
import { notFound } from 'next/navigation';
import { StreamDetail } from '@/components/streams/StreamDetail';
import { listItems } from '@/lib/api/lists';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';

export default async function StreamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMe(`/streams/${id}`);
  const api = await serverApi();
  const [stream, members, orgMembers, list] = await Promise.all([
    api.GET('/v1/streams/{id}', { params: { path: { id } } }),
    api.GET('/v1/streams/{id}/members', { params: { path: { id } } }),
    api.GET('/v1/members'),
    api.GET('/v1/streams'),
  ]);
  // The contract has GET /v1/streams/{id}; the API currently serves only the list (reported), so a
  // missing detail answer falls back to the list entry with the same id. Anything else is 404.
  const detail =
    stream.data ??
    listItems<NonNullable<typeof stream.data>>(list.data).find((s) => s.id === id) ??
    null;
  if (!detail) notFound();
  return (
    <main id="main" className="page">
      <StreamDetail
        stream={detail}
        members={listItems(members.data)}
        orgMembers={listItems(orgMembers.data)}
      />
    </main>
  );
}
