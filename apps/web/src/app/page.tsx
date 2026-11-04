// SPDX-License-Identifier: AGPL-3.0-only
// Default landing when signed in: the permissioned vertical feed (M1a) with M1b filters by
// stream, event tag and pinned state; filters live in the URL and can only narrow the feed.
import { Feed } from '@/components/feed/Feed';
import { FeedFilters } from '@/components/feed/FeedFilters';
import { listItems } from '@/lib/api/lists';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';
import { t } from '@/lib/i18n';
import { TAGS, type Tag } from '@/lib/m1b/search';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireMe();
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const rawStream = first(params['streamId']);
  const streamId = rawStream && UUID_RE.test(rawStream) ? rawStream : undefined;
  const rawTag = first(params['tag']);
  const tag = rawTag && (TAGS as readonly string[]).includes(rawTag) ? (rawTag as Tag) : undefined;
  const pinned = first(params['pinned']) === 'true';
  const api = await serverApi();
  const { data } = await api.GET('/v1/streams');
  const streams = listItems<{ id: string; name: string }>(data).map((s) => ({
    id: s.id,
    name: s.name,
  }));
  return (
    <main id="main" className="feed-page">
      <h1 className="visually-hidden">{t('nav.feed')}</h1>
      <FeedFilters
        streams={streams}
        {...(streamId ? { streamId } : {})}
        {...(tag ? { tag } : {})}
        pinned={pinned}
      />
      <Feed {...(streamId ? { streamId } : {})} {...(tag ? { tag } : {})} pinned={pinned} />
    </main>
  );
}
