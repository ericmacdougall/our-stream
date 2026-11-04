// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  UPLOAD_CHUNK_BYTES,
  chunkSizeFor,
  contentKindFor,
  mediaMimeType,
  partCountFor,
} from './upload.js';

describe('multipart sizing', () => {
  it('uses one part for small files and ceil(size/chunk) otherwise', () => {
    expect(partCountFor(1)).toBe(1);
    expect(partCountFor(UPLOAD_CHUNK_BYTES)).toBe(1);
    expect(partCountFor(UPLOAD_CHUNK_BYTES + 1)).toBe(2);
    expect(partCountFor(100 * UPLOAD_CHUNK_BYTES)).toBe(100);
  });
  it('never exceeds 10 000 parts, matching Uppy', () => {
    const huge = 4 * 1024 * 1024 * 1024;
    expect(chunkSizeFor(huge)).toBe(UPLOAD_CHUNK_BYTES);
    const absurd = 200 * 1024 * 1024 * 1024;
    expect(partCountFor(absurd)).toBeLessThanOrEqual(10_000);
  });
});

describe('mediaMimeType', () => {
  it('prefers a valid browser type, falls back to extension, rejects others', () => {
    expect(mediaMimeType('a.mp4', 'video/mp4')).toBe('video/mp4');
    expect(mediaMimeType('a.mov', '')).toBe('video/quicktime');
    expect(mediaMimeType('a.MP3', 'application/octet-stream')).toBe('audio/mpeg');
    expect(mediaMimeType('a.pdf', 'application/pdf')).toBeNull();
    expect(mediaMimeType('noext', '')).toBeNull();
  });
  it('derives the content kind', () => {
    expect(contentKindFor('audio/mpeg')).toBe('audio');
    expect(contentKindFor('video/mp4')).toBe('clip');
  });
});
