// SPDX-License-Identifier: AGPL-3.0-only
// Keyword search over documents. The query lives only in the URL (a plain GET form), is validated before any
// request, and the page renders the API's plain-text snippets as text with <mark> highlights.
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import type { DocumentSearchResponse } from '@our-stream/contracts';
import { DocumentsOff } from '@/components/documents/DocumentsOff';
import { Snippet } from '@/components/documents/Snippet';
import { Notice } from '@/components/Notice';
import { requireMe } from '@/lib/api/require';
import { getDocumentsEnabled, serverApi } from '@/lib/api/server';
import { checkSearchQuery, formatBytes, type DocumentFormat } from '@/lib/documents';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('nav.documents')} · ${t('app.name')}` };

const PAGE_SIZE = 20;
const TOTAL_CAP = 1000;

type SearchParams = Promise<{ q?: string | string[]; cursor?: string | string[] }>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function DocumentsPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const rawQuery = first(raw.q);
  const cursor = first(raw.cursor);
  const me = await requireMe('/documents');
  const enabled = await getDocumentsEnabled();
  const canManage = me.org?.role === 'owner' || me.org?.role === 'admin';

  let content: ReactNode = null;
  if (enabled === false) {
    content = <DocumentsOff canManage={canManage} />;
  } else if (rawQuery !== undefined) {
    const check = checkSearchQuery(rawQuery);
    if (!check.ok) {
      content = (
        <Notice kind="error">
          {t(check.reason === 'empty' ? 'documents.searchEmpty' : 'documents.searchTooLong')}
        </Notice>
      );
    } else {
      const api = await serverApi();
      const result = await api
        .GET('/v1/search/documents', {
          params: { query: { q: check.q, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
        })
        .catch(() => null);
      if (!result || !result.data) {
        const status = result?.response.status;
        const code = (result?.error as { error?: { code?: string } } | undefined)?.error?.code;
        content = (
          <Notice kind="error">
            {status === 429
              ? t('documents.searchRateLimited')
              : code === 'feature_disabled'
                ? t('error.featureDisabled')
                : t('documents.searchFailed')}
          </Notice>
        );
      } else {
        // The client's path typings are an intersection of generated and hand-written types and resolve
        // loosely here, so pin the shape to the contract schema.
        const { items, total, nextCursor } = result.data as z.output<typeof DocumentSearchResponse>;
        const next = new URLSearchParams({
          q: check.q,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        });
        content = (
          <section aria-labelledby="results-heading">
            <h2 id="results-heading" data-testid="results-count">
              {total >= TOTAL_CAP
                ? t('documents.searchResultsCapped', { total: TOTAL_CAP })
                : t('documents.searchResults', { total })}
            </h2>
            <ul className="list results" data-testid="results">
              {items.map((hit) => (
                <li key={hit.id} className="card" data-testid="result">
                  <h3>
                    <Link href={`/documents/${hit.id}`}>{hit.title}</Link>
                  </h3>
                  <p className="muted">
                    {t('documents.resultMeta', {
                      owner: hit.owner.displayName,
                      format: t(
                        `documents.format.${hit.document.format}` satisfies `documents.format.${DocumentFormat}`,
                      ),
                      size: formatBytes(hit.document.size),
                    })}
                  </p>
                  {hit.snippets.map((s, i) => (
                    <p key={i} className="snippet" data-source={s.source}>
                      <Snippet text={s.text} ranges={s.ranges} />
                      {s.anchor ? <span className="muted"> ({s.anchor.label})</span> : null}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
            {nextCursor ? (
              <p>
                <Link className="button" href={`/documents?${next.toString()}`}>
                  {t('documents.searchNext')}
                </Link>
              </p>
            ) : null}
          </section>
        );
      }
    }
  }

  return (
    <main id="main" className="page">
      <header className="masthead">
        <h1>{t('documents.heading')}</h1>
        <p className="muted">{t('documents.intro')}</p>
      </header>
      {enabled === false ? null : (
        <form action="/documents" method="get" role="search" className="card form">
          <div className="field">
            <label htmlFor="q">{t('documents.searchLabel')}</label>
            <input id="q" name="q" type="search" defaultValue={rawQuery ?? ''} maxLength={2000} />
          </div>
          <div className="actions">
            <button type="submit" className="primary">
              {t('documents.searchSubmit')}
            </button>
          </div>
        </form>
      )}
      {content}
    </main>
  );
}
