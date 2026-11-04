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
  const [stream, members, orgMembers] = await Promise.all([
    api.GET('/v1/streams/{id}', { params: { path: { id } } }),
    api.GET('/v1/streams/{id}/members', { params: { path: { id } } }),
    api.GET('/v1/members'),
  ]);
  if (!stream.data) notFound();
  return (
    <main id="main" className="page">
      <StreamDetail
        stream={stream.data}
        members={listItems(members.data)}
        orgMembers={listItems(orgMembers.data)}
      />
    </main>
  );
}
