// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Create content -> multipart upload -> poll processing -> hand off to publish. A replacement
// (existing contentId) skips the metadata form and uploads a new version of the same content.
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import type { ContentDetail } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import { normaliseChapters, parseTimestamp } from '@/lib/feed/chapters';
import { t } from '@/lib/i18n';
import { contentKindFor, mediaMimeType } from '@/lib/upload';
import { ProcessingStatus } from '../content/ProcessingStatus';
import { useContentPolling } from '../content/useContentPolling';
import { Notice } from '../Notice';
import { ChaptersEditor, type ChapterDraft } from './ChaptersEditor';
import { LinksEditor, type LinkDraft } from './LinksEditor';
import { createUploader, FilePicker, UploadProgressBar, type UploadProgress } from './Uploader';

type Detail = z.output<typeof ContentDetail>;
type Phase = 'form' | 'creating' | 'uploading' | 'processing' | 'done' | 'error';

export function UploadFlow({ replaceOf }: { replaceOf?: Detail }) {
  const [title, setTitle] = useState(replaceOf?.title ?? '');
  const [description, setDescription] = useState(replaceOf?.description ?? '');
  const [language, setLanguage] = useState(replaceOf?.language ?? 'en');
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [chapters, setChapters] = useState<ChapterDraft[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Detail | null>(null);
  const [uploadedVersionId, setUploadedVersionId] = useState<string | null>(null);
  const busy = useRef(false);
  const { detail, processing, stalled } = useContentPolling(created, {
    untilVersionId: uploadedVersionId,
  });

  const working = phase === 'creating' || phase === 'uploading';
  const final = detail ?? created;
  const uploadedIsCurrent =
    final?.currentVersion !== null &&
    final?.currentVersion !== undefined &&
    final.currentVersion.id === uploadedVersionId;
  const versionStatus = uploadedIsCurrent ? final.currentVersion?.status : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    setError(null);
    if (!file) {
      setError(t('upload.fileRequired'));
      return;
    }
    const mimeType = mediaMimeType(file.name, file.type);
    if (!mimeType) {
      setError(t('upload.unsupportedType'));
      return;
    }
    const badChapter = chapters.find((c) => c.at.trim() !== '' && parseTimestamp(c.at) === null);
    if (badChapter) {
      setError(t('upload.chapterInvalid', { value: badChapter.at }));
      return;
    }
    const halfChapter = chapters.findIndex((c) => (c.at.trim() === '') !== (c.title.trim() === ''));
    if (halfChapter >= 0) {
      setError(t('upload.chapterIncomplete', { n: halfChapter + 1 }));
      return;
    }
    const halfLink = links.findIndex((l) => l.url.trim() === '' && l.label.trim() !== '');
    if (halfLink >= 0) {
      setError(t('upload.linkIncomplete', { n: halfLink + 1 }));
      return;
    }
    busy.current = true;
    try {
      let target: Detail;
      if (replaceOf) {
        target = replaceOf;
      } else {
        setPhase('creating');
        const result = await browserApi().POST('/v1/content', {
          body: {
            kind: contentKindFor(mimeType),
            title: title.trim(),
            description: description.trim(),
            language: language.trim() || 'en',
            links: links
              .filter((l) => l.url.trim() !== '')
              .map((l) => ({ kind: l.kind, url: l.url.trim(), label: l.label.trim() })),
            chapters: normaliseChapters(
              chapters
                .filter((c) => c.at.trim() !== '' && c.title.trim() !== '')
                .map((c) => ({ atMs: parseTimestamp(c.at) ?? 0, title: c.title })),
            ),
          },
        });
        const message = errorMessage(result);
        if (message || !result.data) {
          setError(message ?? t('error.generic'));
          setPhase('form');
          return;
        }
        target = result.data;
      }
      setPhase('uploading');
      setProgress({ bytesUploaded: 0, bytesTotal: file.size });
      const outcome = await createUploader(setProgress).upload(target.id, file);
      setUploadedVersionId(outcome.versionId);
      setCreated(outcome.detail);
      setPhase('processing');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('error.generic'));
      setPhase('error');
    } finally {
      busy.current = false;
    }
  }

  if (phase === 'processing' || phase === 'done') {
    const id = final?.id ?? '';
    return (
      <section className="card" aria-labelledby="upload-status-heading">
        <h2 id="upload-status-heading">{t('upload.uploaded')}</h2>
        <ProcessingStatus
          version={uploadedIsCurrent ? (final?.currentVersion ?? null) : null}
          pending={processing}
        />
        {stalled ? <Notice kind="error">{t('upload.pollingStalled')}</Notice> : null}
        {!processing && versionStatus === 'current' ? (
          <div className="actions">
            <Link className="button primary" href={`/content/${id}/publish`}>
              {t('upload.continueToPublish')}
            </Link>
            <Link className="button" href={`/content/${id}`}>
              {t('upload.viewContent')}
            </Link>
          </div>
        ) : null}
        {versionStatus === 'failed' ? (
          <p>
            <Link href={`/content/${id}`}>{t('upload.viewContent')}</Link>
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="card form" noValidate aria-busy={working}>
      <h2>{replaceOf ? t('upload.replaceHeading') : t('upload.heading')}</h2>
      {!replaceOf ? (
        <>
          <div className="field">
            <label htmlFor="title">{t('upload.title')}</label>
            <input
              id="title"
              required
              maxLength={200}
              value={title}
              disabled={working}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="description">{t('upload.description')}</label>
            <textarea
              id="description"
              rows={4}
              maxLength={4000}
              value={description}
              disabled={working}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="language">{t('upload.language')}</label>
            <input
              id="language"
              className="short"
              minLength={2}
              maxLength={16}
              value={language}
              disabled={working}
              aria-describedby="language-hint"
              onChange={(e) => setLanguage(e.target.value)}
            />
            <small id="language-hint" className="muted">
              {t('upload.languageHint')}
            </small>
          </div>
          <LinksEditor links={links} onChange={setLinks} disabled={working} />
          <ChaptersEditor chapters={chapters} onChange={setChapters} disabled={working} />
        </>
      ) : null}
      <FilePicker file={file} onFile={setFile} disabled={working} />
      <Notice kind="error">{error}</Notice>
      {phase === 'creating' ? <Notice>{t('upload.creating')}</Notice> : null}
      {phase === 'uploading' ? <UploadProgressBar progress={progress} /> : null}
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={working || !file || (!replaceOf && title.trim() === '')}
        >
          {working
            ? t('common.working')
            : replaceOf
              ? t('upload.replaceSubmit')
              : t('upload.submit')}
        </button>
      </div>
    </form>
  );
}
