// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  CreateContentRequest,
  DocumentInfo,
  DocumentSearchQuery,
  DocumentViewerQuery,
  OrgSettings,
  UploadInitRequest,
} from './index.js';

describe('M2a contract', () => {
  it('content can be created as a document; unknown kinds are still refused', () => {
    expect(CreateContentRequest.safeParse({ kind: 'document', title: 'Handbook' }).success).toBe(
      true,
    );
    expect(CreateContentRequest.safeParse({ kind: 'page', title: 'x' }).success).toBe(false);
  });
  it('document info carries scanStatus not_run and nothing else', () => {
    const ok = {
      format: 'pdf',
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      size: 1,
      scanStatus: 'not_run',
    };
    expect(DocumentInfo.safeParse(ok).success).toBe(true);
    expect(DocumentInfo.safeParse({ ...ok, scanStatus: 'clean' }).success).toBe(false);
    expect(DocumentInfo.safeParse({ ...ok, format: 'doc' }).success).toBe(false);
  });
  it('upload init accepts a document MIME type shape and refuses junk', () => {
    const base = { fileName: 'a.docx', size: 10, parts: 1 };
    expect(
      UploadInitRequest.safeParse({
        ...base,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }).success,
    ).toBe(true);
    for (const bad of ['', 'pdf', 'application/', '/pdf', 'text/html; charset=utf-8', 'a b/c'])
      expect(UploadInitRequest.safeParse({ ...base, mimeType: bad }).success, bad).toBe(false);
  });
  it('document search takes up to 2,000 characters and an empty query; viewer pages are capped at 500', () => {
    expect(DocumentSearchQuery.safeParse({ q: '' }).success).toBe(true);
    expect(DocumentSearchQuery.safeParse({ q: 'a'.repeat(2000) }).success).toBe(true);
    expect(DocumentSearchQuery.safeParse({ q: 'a'.repeat(2001) }).success).toBe(false);
    expect(DocumentViewerQuery.safeParse({ limit: '500' }).success).toBe(true);
    expect(DocumentViewerQuery.safeParse({ limit: '501' }).success).toBe(false);
  });
  it('org settings require the documents flag as a boolean', () => {
    const base = {
      privacyMode: 'named',
      commentsEnabled: true,
      engagementRetentionDays: 395,
      commentScanPolicy: 'off',
    };
    expect(OrgSettings.safeParse({ ...base, documentsEnabled: true }).success).toBe(true);
    expect(OrgSettings.safeParse(base).success).toBe(false);
    expect(OrgSettings.safeParse({ ...base, documentsEnabled: 'true' }).success).toBe(false);
  });
});
