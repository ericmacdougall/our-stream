// SPDX-License-Identifier: AGPL-3.0-only
// Multipart upload parameters shared by the init request and Uppy so part counts always agree.
import { checkDocumentFile, looksLikeDocument } from './documents';

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const UPLOAD_MAX_PARTS = 10_000;
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** Uppy raises the chunk size so a file never needs more than 10 000 parts; mirror that here. */
export function chunkSizeFor(size: number): number {
  return Math.max(UPLOAD_CHUNK_BYTES, Math.ceil(size / UPLOAD_MAX_PARTS));
}

export function partCountFor(size: number): number {
  return Math.max(1, Math.ceil(size / chunkSizeFor(size)));
}

const BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
};

const MIME_RE = /^(video|audio)\/[a-z0-9.+-]+$/i;

/** The browser's type when it is a video/audio type, else a guess from the extension, else null. */
export function mediaMimeType(fileName: string, browserType: string): string | null {
  if (MIME_RE.test(browserType)) return browserType;
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return BY_EXT[ext] ?? null;
}

/**
 * The MIME type to declare at upload/init: a media type for video/audio files, the extension's allow-listed
 * type for a valid document, else null (the caller shows the specific refusal from checkDocumentFile).
 */
export function uploadMimeType(file: { name: string; size: number; type?: string }): string | null {
  if (looksLikeDocument(file.name)) {
    const verdict = checkDocumentFile(file);
    return verdict.ok ? verdict.mimeType : null;
  }
  return mediaMimeType(file.name, file.type ?? '');
}

export function contentKindFor(mimeType: string): 'clip' | 'audio' | 'document' {
  const type = mimeType.toLowerCase();
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'clip';
  return 'document';
}
