// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Parsed text of a document as sections (page, slide, sheet or heading anchors). Everything is rendered as
// text nodes: the API never returns the original's markup and this component never interprets it. The
// original is reachable only through the attachment download link.
import { useRef, useState } from 'react';
import type { z } from 'zod';
import type { DocumentViewerResponse } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';
import {
  formatBytes,
  joinChunks,
  mergeSections,
  originalDownloadHref,
  sectionId,
  type DocumentFormat,
} from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { Notice } from '../Notice';

type Viewer = z.output<typeof DocumentViewerResponse>;

export function DocumentViewer({ initial }: { initial: Viewer }) {
  const [sections, setSections] = useState(initial.sections);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const doc = initial.document;

  async function loadMore() {
    if (inFlight.current || !nextCursor) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await browserApi().GET('/v1/content/{id}/document', {
        params: { path: { id: initial.id }, query: { cursor: nextCursor } },
      });
      const message = errorMessage(result);
      if (message || !result.data) {
        setError(message ?? t('documents.loadFailed'));
        return;
      }
      const data = result.data;
      setSections((prev) => mergeSections(prev, data.sections));
      setNextCursor(data.nextCursor);
    } catch {
      setError(t('documents.loadFailed'));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <header className="masthead">
        <h1>{initial.title}</h1>
        <p className="muted" data-testid="document-meta">
          {t(`documents.format.${doc.format}` satisfies `documents.format.${DocumentFormat}`)} ·{' '}
          {doc.fileName} · {formatBytes(doc.size)}
        </p>
      </header>
      <section className="card" aria-labelledby="document-actions-heading">
        <h2 id="document-actions-heading" className="visually-hidden">
          {t('documents.fileInfo')}
        </h2>
        <p>{t('documents.viewerTextOnly')}</p>
        <Notice id="not-scanned-notice">{t('documents.notScannedViewer')}</Notice>
        <div className="actions">
          <a
            className="button"
            data-testid="download-original"
            href={originalDownloadHref(initial.id)}
          >
            {t('documents.downloadFile', { name: doc.fileName })}
          </a>
        </div>
      </section>
      {sections.length > 1 ? (
        <nav className="card" aria-label={t('documents.anchors')}>
          <h2>{t('documents.anchors')}</h2>
          <ol className="list doc-anchors">
            {sections.map((s) => (
              <li key={sectionId(s)}>
                <a href={`#${sectionId(s)}`}>{s.anchor.label}</a>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div data-testid="document-sections">
        {sections.map((s) => (
          <section
            key={sectionId(s)}
            id={sectionId(s)}
            className="card doc-section"
            aria-labelledby={`h-${sectionId(s)}`}
            data-anchor={s.anchor.label}
          >
            <h2 id={`h-${sectionId(s)}`}>{s.anchor.label}</h2>
            <div className="doc-text">{joinChunks(s.chunks)}</div>
          </section>
        ))}
      </div>
      <Notice kind="error">{error}</Notice>
      {nextCursor ? (
        <div className="actions">
          <button type="button" onClick={() => void loadMore()} disabled={pending}>
            {pending ? t('common.working') : t('documents.loadMore')}
          </button>
        </div>
      ) : (
        <p className="muted" data-testid="document-end">
          {t('documents.endOfDocument')}
        </p>
      )}
    </>
  );
}
