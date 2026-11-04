// SPDX-License-Identifier: AGPL-3.0-only
// Default landing when signed in: the permissioned vertical feed (M1a).
import { Feed } from '@/components/feed/Feed';
import { requireMe } from '@/lib/api/require';
import { t } from '@/lib/i18n';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireMe();
  const params = await searchParams;
  const raw = params['streamId'];
  const streamId = Array.isArray(raw) ? raw[0] : raw;
  return (
    <main id="main" className="feed-page">
      <h1 className="visually-hidden">{t('nav.feed')}</h1>
      <Feed {...(streamId ? { streamId } : {})} />
    </main>
  );
}
