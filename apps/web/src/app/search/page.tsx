// SPDX-License-Identifier: AGPL-3.0-only
// Keyword search (M1b, ADR-0013): the query lives in the URL (?q=&streamId=&tag=) so a result list
// and an opened hit (?play=&t=) are shareable deep links. The page validates every parameter before
// the client component asks the API.
import type { Metadata } from 'next';
import { SearchResults } from '@/components/search/SearchResults';
import { listItems } from '@/lib/api/lists';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';
import { t } from '@/lib/i18n';
import { parseSearchParams } from '@/lib/m1b/search';

export const metadata: Metadata = { title: `${t('search.title')} · ${t('app.name')}` };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireMe('/search');
  const params = await searchParams;
  const state = parseSearchParams(params);
  const api = await serverApi();
  const { data } = await api.GET('/v1/streams');
  const streams = listItems<{ id: string; name: string }>(data).map((s) => ({
    id: s.id,
    name: s.name,
  }));
  return (
    <main id="main" className="page">
      <header className="masthead">
        <h1>{t('search.title')}</h1>
      </header>
      <SearchResults initial={state} streams={streams} />
    </main>
  );
}
