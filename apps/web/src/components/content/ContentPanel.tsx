// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { z } from 'zod';
import type { ContentDetail } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import {
  documentOf,
  formatBytes,
  isLiveNow,
  originalDownloadHref,
  type DocumentFormat,
} from '@/lib/documents';
import { formatTimestamp } from '@/lib/feed/chapters';
import { externalHost } from '@/lib/links';
import { t, type MessageId } from '@/lib/i18n';
import { Notice } from '../Notice';
import { UploadFlow } from '../upload/UploadFlow';
import { ProcessingStatus } from './ProcessingStatus';
import { useContentPolling } from './useContentPolling';

type Detail = z.output<typeof ContentDetail>;

const STATE_LABEL: Record<Detail['state'], MessageId> = {
  draft: 'content.state.draft',
  published: 'content.state.published',
  retracted: 'content.state.retracted',
};

function audienceLabel(a: Detail['audience'][number]): string {
  switch (a.type) {
    case 'everyone':
      return t('publish.everyone');
    case 'stream':
      return t('content.audienceStream', { id: a.streamId });
    case 'group':
      return t('content.audienceGroup', { id: a.groupId });
    case 'user':
      return t('content.audienceUser', { id: a.userId });
  }
}

export function ContentPanel({ initial }: { initial: Detail }) {
  const router = useRouter();
  const { detail: polled, setDetail } = useContentPolling(initial);
  const detail = polled ?? initial;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  async function retract() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await browserApi().POST('/v1/content/{id}/retract', {
        params: { path: { id: detail.id } },
      });
      const message = errorMessage(result);
      if (message || !result.data) {
        setError(message ?? t('error.generic'));
        return;
      }
      setDetail(result.data);
      dialogRef.current?.close();
      router.refresh();
    } catch {
      setError(t('error.network'));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const isDocument = detail.kind === 'document';
  const doc = documentOf(detail);
  const live = isLiveNow(detail);
  const failedDocument = isDocument && detail.currentVersion?.status === 'failed';
  const canRetract = detail.canEdit && detail.state !== 'retracted';
  const canPublish =
    detail.canEdit && detail.state !== 'retracted' && detail.currentVersion?.status === 'current';

  return (
    <>
      <header className="masthead">
        <h1>{detail.title}</h1>
        <p className="muted">
          {t('content.byOwner', { name: detail.owner.displayName })} ·{' '}
          <span data-testid="content-state">{t(STATE_LABEL[detail.state])}</span>
          {detail.publishAt
            ? ` · ${t('content.publishAt', { when: formatter.format(new Date(detail.publishAt)) })}`
            : ''}
          {detail.expiresAt
            ? ` · ${t('content.expiresAt', { when: formatter.format(new Date(detail.expiresAt)) })}`
            : ''}
          {detail.retractedAt
            ? ` · ${t('content.retractedAt', { when: formatter.format(new Date(detail.retractedAt)) })}`
            : ''}
        </p>
      </header>
      <section className="card" aria-labelledby="content-status-heading">
        <h2 id="content-status-heading">{t('content.statusHeading')}</h2>
        <ProcessingStatus version={detail.currentVersion} kind={detail.kind} />
        {failedDocument ? <p className="muted">{t('documents.failureIntro')}</p> : null}
        {isDocument ? <Notice id="not-scanned-notice">{t('documents.notScanned')}</Notice> : null}
        <Notice kind="error">{error}</Notice>
        <div className="actions">
          {canPublish ? (
            <Link className="button primary" href={`/content/${detail.id}/publish`}>
              {detail.state === 'published' ? t('content.editAudience') : t('content.publish')}
            </Link>
          ) : null}
          {isDocument && live && detail.currentVersion?.status === 'current' ? (
            <>
              <Link className="button" href={`/documents/${detail.id}`}>
                {t('documents.view')}
              </Link>
              <a className="button" href={originalDownloadHref(detail.id)}>
                {t('documents.download')}
              </a>
            </>
          ) : null}
          {canRetract ? (
            <button
              type="button"
              className="danger"
              onClick={() => dialogRef.current?.showModal()}
              disabled={pending}
            >
              {t('content.retract')}
            </button>
          ) : null}
          {detail.canEdit && detail.state !== 'retracted' ? (
            <button type="button" onClick={() => setReplacing((r) => !r)} aria-expanded={replacing}>
              {replacing
                ? t('common.cancel')
                : isDocument
                  ? t('content.documentReplace')
                  : t('content.replace')}
            </button>
          ) : null}
        </div>
        {replacing ? <UploadFlow replaceOf={detail} /> : null}
      </section>
      <section className="card" aria-labelledby="content-meta-heading">
        <h2 id="content-meta-heading">{t('content.metaHeading')}</h2>
        {detail.description ? <p>{detail.description}</p> : null}
        <dl className="meta">
          {doc ? (
            <>
              <dt>{t('documents.fileInfo')}</dt>
              <dd data-testid="document-file">{doc.fileName}</dd>
              <dt>{t('content.document.format')}</dt>
              <dd>
                {t(`documents.format.${doc.format}` satisfies `documents.format.${DocumentFormat}`)}
              </dd>
              <dt>{t('content.document.size')}</dt>
              <dd>{formatBytes(doc.size)}</dd>
            </>
          ) : null}
          <dt>{t('upload.language')}</dt>
          <dd>{detail.language}</dd>
          <dt>{t('publish.audience')}</dt>
          <dd>
            {detail.audience.length === 0 ? (
              t('content.audienceNone')
            ) : (
              <ul className="list">
                {detail.audience.map((a, i) => (
                  <li key={i}>{audienceLabel(a)}</li>
                ))}
              </ul>
            )}
          </dd>
          {detail.chapters.length > 0 ? (
            <>
              <dt>{t('upload.chapters')}</dt>
              <dd>
                <ol className="list">
                  {detail.chapters.map((c) => (
                    <li key={c.atMs}>
                      {formatTimestamp(c.atMs)} {c.title}
                    </li>
                  ))}
                </ol>
              </dd>
            </>
          ) : null}
          {detail.links.length > 0 ? (
            <>
              <dt>{t('upload.links')}</dt>
              <dd>
                <ul className="list">
                  {detail.links.map((l) => (
                    <li key={l.url}>
                      {externalHost(l.url) === null ? (
                        <span>{l.label || t('feed.linkUnavailable')}</span>
                      ) : (
                        <a href={l.url} rel="noopener noreferrer">
                          {l.label || l.url}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
      </section>
      <dialog
        ref={dialogRef}
        className="dialog"
        aria-labelledby="retract-heading"
        onCancel={(e) => {
          // Escape keeps the content: close without retracting.
          e.preventDefault();
          if (!pending) dialogRef.current?.close();
        }}
      >
        <h2 id="retract-heading">
          {isDocument ? t('content.retractConfirmDocumentTitle') : t('content.retractConfirmTitle')}
        </h2>
        <p>
          {isDocument ? t('content.retractConfirmDocumentBody') : t('content.retractConfirmBody')}
        </p>
        <div className="actions">
          <button type="button" onClick={() => dialogRef.current?.close()} disabled={pending}>
            {t('content.keep')}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void retract()}
            disabled={pending}
          >
            {pending ? t('common.working') : t('content.retractConfirm')}
          </button>
        </div>
      </dialog>
    </>
  );
}
