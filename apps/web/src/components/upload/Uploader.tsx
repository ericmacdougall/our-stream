// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Multipart upload through Uppy's AwsS3 plugin with our own signing: upload/init hands back every
// part URL up front and upload/complete finalises the version (ADR-0003). The browser never sees
// storage credentials; the API is the only party that signs.
import Uppy, { type Meta, type UppyFile } from '@uppy/core';
import AwsS3 from '@uppy/aws-s3';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { ContentDetail } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { chunkSizeFor, mediaMimeType, partCountFor } from '@/lib/upload';

type Detail = z.output<typeof ContentDetail>;
type Body = Record<string, never>;

export interface UploadOutcome {
  detail: Detail;
  /** The version created by upload/init; polling waits for it to become current. */
  versionId: string;
}

export interface UploaderHandle {
  /** Starts uploading `file` as a new version of `contentId`; resolves once upload/complete returns. */
  upload(contentId: string, file: File): Promise<UploadOutcome>;
}

export interface UploadProgress {
  bytesUploaded: number;
  bytesTotal: number;
}

/** Creates a one-shot Uppy instance wired to the contract's upload endpoints. */
export function createUploader(onProgress: (p: UploadProgress) => void): UploaderHandle {
  return {
    upload(contentId, file) {
      return new Promise<UploadOutcome>((resolve, reject) => {
        const partUrls = new Map<string, Map<number, string>>();
        const versionIds = new Map<string, string>();
        let completed: UploadOutcome | null = null;
        const api = browserApi();

        const uppy = new Uppy<Meta, Body>({
          autoProceed: true,
          allowMultipleUploadBatches: false,
          restrictions: { maxNumberOfFiles: 1 },
        });

        uppy.use(AwsS3<Meta, Body>, {
          shouldUseMultipart: true,
          getChunkSize: (f: { size: number }) => chunkSizeFor(f.size),
          async createMultipartUpload(f: UppyFile<Meta, Body>) {
            const size = f.size ?? 0;
            const mimeType = mediaMimeType(f.name ?? '', f.type ?? '');
            if (!mimeType) throw new Error(t('upload.unsupportedType'));
            const result = await api.POST('/v1/content/{id}/upload/init', {
              params: { path: { id: contentId } },
              body: { fileName: f.name ?? 'upload', mimeType, size, parts: partCountFor(size) },
            });
            if (!result.data) throw new Error(errorMessage(result) ?? t('error.generic'));
            partUrls.set(
              result.data.uploadId,
              new Map(
                result.data.partUrls.map((p: { partNumber: number; url: string }) => [
                  p.partNumber,
                  p.url,
                ]),
              ),
            );
            versionIds.set(result.data.uploadId, result.data.versionId);
            return { uploadId: result.data.uploadId, key: result.data.key };
          },
          async signPart(_f: UppyFile<Meta, Body>, opts: { uploadId: string; partNumber: number }) {
            const url = partUrls.get(opts.uploadId)?.get(opts.partNumber);
            if (!url) throw new Error(t('upload.partMissing', { part: opts.partNumber }));
            return { url };
          },
          async listParts() {
            return [];
          },
          async completeMultipartUpload(
            _f: UppyFile<Meta, Body>,
            opts: {
              uploadId: string;
              key: string;
              parts: { PartNumber?: number; ETag?: string }[];
            },
          ) {
            const versionId = versionIds.get(opts.uploadId);
            if (!versionId) throw new Error(t('error.generic'));
            const result = await api.POST('/v1/content/{id}/upload/complete', {
              params: { path: { id: contentId } },
              body: {
                versionId,
                uploadId: opts.uploadId,
                parts: opts.parts.map((p) => ({
                  partNumber: p.PartNumber ?? 0,
                  etag: (p.ETag ?? '').replace(/^"|"$/g, ''),
                })),
              },
            });
            if (!result.data) throw new Error(errorMessage(result) ?? t('error.generic'));
            completed = { detail: result.data, versionId };
            return {};
          },
          async abortMultipartUpload() {
            // Nothing to release client-side; the API reaps abandoned uploads.
          },
        });

        uppy.on('upload-progress', (_file, progress) => {
          onProgress({
            bytesUploaded: progress.bytesUploaded || 0,
            bytesTotal: progress.bytesTotal ?? file.size,
          });
        });
        uppy.on('upload-error', (_file, error) => {
          uppy.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
        uppy.on('complete', (result) => {
          uppy.destroy();
          if (completed) resolve(completed);
          else reject(new Error(result.failed?.[0]?.error ?? t('error.generic')));
        });

        try {
          uppy.addFile({ name: file.name, type: file.type, data: file, source: 'local' });
        } catch (err) {
          uppy.destroy();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  };
}

export function UploadProgressBar({ progress }: { progress: UploadProgress | null }) {
  if (!progress) return null;
  const pct =
    progress.bytesTotal > 0 ? Math.round((progress.bytesUploaded / progress.bytesTotal) * 100) : 0;
  return (
    <div className="progress">
      <progress value={pct} max={100} aria-label={t('upload.progressLabel')} />
      <span aria-live="polite">{t('upload.progress', { pct })}</span>
    </div>
  );
}

/** Accessible file picker with a drop zone; exposes the chosen file. */
export function FilePicker({
  file,
  onFile,
  disabled,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file && inputRef.current) inputRef.current.value = '';
  }, [file]);

  return (
    <div
      className={`dropzone${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (disabled) return;
        const dropped = e.dataTransfer.files?.[0] ?? null;
        if (dropped) onFile(dropped);
      }}
    >
      <label htmlFor="file">{t('upload.chooseFile')}</label>
      <input
        ref={inputRef}
        id="file"
        name="file"
        type="file"
        accept="video/*,audio/*"
        disabled={disabled}
        aria-describedby="file-hint"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />
      <small id="file-hint" className="muted">
        {file ? t('upload.selected', { name: file.name }) : t('upload.dropHint')}
      </small>
    </div>
  );
}
