// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { z } from 'zod';
import type { DocumentListResponse } from '@our-stream/contracts';
import { DocumentsOff } from '@/components/documents/DocumentsOff';
import { Notice } from '@/components/Notice';
import { requireMe } from '@/lib/api/require';
import { getDocumentsEnabled, serverApi } from '@/lib/api/server';
import { formatBytes, type DocumentFormat } from '@/lib/documents';
import { t } from '@/lib/i18n';

type SearchParams = Promise<{ cursor?: string | string[] }>;

export default async function StreamDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const rawCursor = (await searchParams).cursor;
  const cursor = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor;
  const me = await requireMe(`/streams/${id}/documents`);
  const api = await serverApi();
  const stream = await api.GET('/v1/streams/{id}', { params: { path: { id } } });
  if (!stream.data) notFound();
  const enabled = await getDocumentsEnabled();
  const canManage = me.org?.role === 'owner' || me.org?.role === 'admin';
  const list =
    enabled === false
      ? null
      : await api
          .GET('/v1/streams/{id}/documents', {
            params: { path: { id }, query: { limit: 20, ...(cursor ? { cursor } : {}) } },
          })
          .catch(() => null);
  const page = (list?.data ?? null) as z.output<typeof DocumentListResponse> | null;
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

  return (
    <main id="main" className="page">
      <header className="masthead">
        <h1>{t('documents.streamList')}</h1>
        <p className="muted">
          <Link href={`/streams/${id}`}>{stream.data.name}</Link>
        </p>
      </header>
      {enabled === false ? (
        <DocumentsOff canManage={canManage} />
      ) : !page ? (
        <Notice kind="error">{t('documents.listFailed')}</Notice>
      ) : page.items.length === 0 ? (
        <p className="muted" data-testid="documents-empty">
          {t('documents.streamListEmpty')}
        </p>
      ) : (
        <>
          <ul className="list" data-testid="documents-list">
            {page.items.map((d) => (
              <li key={d.id} className="card" data-testid="document-item">
                <h2>
                  <Link href={`/documents/${d.id}`}>{d.title}</Link>
                </h2>
                {d.description ? <p>{d.description}</p> : null}
                <p className="muted">
                  {t('documents.resultMeta', {
                    owner: d.owner.displayName,
                    format: t(
                      `documents.format.${d.document.format}` satisfies `documents.format.${DocumentFormat}`,
                    ),
                    size: formatBytes(d.document.size),
                  })}{' '}
                  · {t('documents.publishedOn', { when: formatter.format(new Date(d.publishAt)) })}
                </p>
              </li>
            ))}
          </ul>
          {page.nextCursor ? (
            <p>
              <Link
                className="button"
                href={`/streams/${id}/documents?cursor=${encodeURIComponent(page.nextCursor)}`}
              >
                {t('documents.streamListMore')}
              </Link>
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}
