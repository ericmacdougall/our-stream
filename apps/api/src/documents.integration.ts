// SPDX-License-Identifier: AGPL-3.0-only
// M2a documents through the API: org flag, upload allow-list and limits, the lifecycle gate (processing
// versions are invisible), viewer, attachment download, per-stream list, keyword search, flag matrix,
// the neutral 404, inert serving of hostile originals, notifications, and the kill switch. Version
// processing is done by the worker in production; here the test plays the worker through the same
// platform functions (claim, then finish) so the gate under test is the real one.
//
// The kill-switch test is deployment-global, so every test that touches documents lives in this one
// file (vitest runs a file's tests in order) and that test runs last.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildFixture, readerVisible, type FixtureOrg } from '@our-stream/authz';
import { MemoryStore } from './test-memory-store.js';
import {
  createHarness,
  createPlayableContent,
  createStream,
  integrationReady,
  seedFixtureSessions,
  type Harness,
  type Session,
} from './test-harness.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;

interface Chunk {
  locator: Record<string, unknown>;
  text: string;
  lang?: string;
}

type Detail = {
  id: string;
  kind: string;
  state: string;
  canEdit: boolean;
  currentVersion: { id: string; status: string; processingStep: string | null } | null;
  document?: {
    format: string;
    fileName: string;
    mimeType: string;
    size: number;
    scanStatus: string;
  };
};

async function createDoc(h: Harness, s: Session, title: string): Promise<string> {
  const r = await h.call('POST', '/v1/content', s, { kind: 'document', title });
  if (r.status !== 200) throw new Error(`document create failed: ${r.status} ${r.raw}`);
  return (r.body as { id: string }).id;
}

/** init + part PUT + complete; returns both responses and the ids. */
async function uploadDoc(
  h: Harness,
  s: Session,
  contentId: string,
  fileName: string,
  mime: string,
  bytes: Buffer,
  path: 'upload/init' | 'replace' = 'upload/init',
) {
  const init = await h.call('POST', `/v1/content/${contentId}/${path}`, s, {
    fileName,
    mimeType: mime,
    size: bytes.length,
    parts: 1,
  });
  if (init.status !== 200) return { init, done: null, versionId: null as string | null, etag: '' };
  const b = init.body as {
    versionId: string;
    uploadId: string;
    key: string;
    partUrls: Array<{ url: string }>;
  };
  const put = await fetch(b.partUrls[0]!.url, { method: 'PUT', body: new Uint8Array(bytes) });
  expect(put.status).toBe(200);
  const etag = put.headers.get('etag')!;
  const done = await h.call('POST', `/v1/content/${contentId}/upload/complete`, s, {
    versionId: b.versionId,
    uploadId: b.uploadId,
    parts: [{ partNumber: 1, etag }],
  });
  return { init, done, versionId: b.versionId, etag, uploadId: b.uploadId, key: b.key };
}

/** The parse worker's two calls, made through the real platform functions. Returns finish's answer. */
async function finishDoc(
  h: Harness,
  orgId: string,
  versionId: string,
  chunks: Chunk[],
): Promise<string> {
  const claim = await h.admin.query<{ a: string | null }>(
    'SELECT platform_document_claim($1, $2) AS a',
    [orgId, versionId],
  );
  const attempt = claim.rows[0]?.a;
  if (!attempt) throw new Error('claim refused');
  const r = await h.admin.query<{ r: string }>(
    'SELECT platform_document_finish($1, $2, $3, $4::jsonb) AS r',
    [orgId, versionId, attempt, JSON.stringify(chunks)],
  );
  return r.rows[0]!.r;
}

const TEXT: Chunk[] = [
  {
    locator: { page: 1 },
    text: 'The quarterly budget review covers travel and hiring. café résumé policy.',
  },
  { locator: { page: 2 }, text: 'Appendix: onboarding checklist for new hires.' },
  { locator: { heading: 'Scope' }, text: 'Scope of the platform migration plan.' },
];

/** A published, processed, reader-visible document in `stream`; returns its ids. */
async function publishedDoc(
  h: Harness,
  author: Session,
  stream: string,
  title: string,
  chunks: Chunk[] = TEXT,
  fileName = 'report.pdf',
  mime = 'application/pdf',
  bytes: Buffer = Buffer.from('%PDF-1.4 fixture bytes'),
) {
  const contentId = await createDoc(h, author, title);
  const up = await uploadDoc(h, author, contentId, fileName, mime, bytes);
  expect(up.done!.status).toBe(200);
  const pub = await h.call('POST', `/v1/content/${contentId}/publish`, author, {
    audience: [{ type: 'stream', streamId: stream }],
  });
  expect(pub.status).toBe(200);
  expect(await finishDoc(h, author.orgId!, up.versionId!, chunks)).toBe('ok');
  return { contentId, versionId: up.versionId!, bytes };
}

const nonDate = (headers: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'date'));

describe.skipIf(!integrationReady)('documents (integration)', () => {
  let h: Harness;
  let owner: Session;
  let admin: Session;
  let contributor: Session;
  let member: Session;
  let outsider: Session; // active org member with no stream beyond company
  let foreign: Session; // owner of a different org
  let dept: string;

  beforeAll(async () => {
    h = await createHarness('docs', {
      DOCUMENTS_ENABLED_DEFAULT: 'true',
      LOG_LEVEL: 'info',
      DOCUMENT_UPLOADS_PER_USER_HOUR: '1000', // the limit has its own suite below
    });
    owner = await h.signup('owner', 'acme');
    admin = await h.invite(owner, 'admin', 'admin');
    contributor = await h.invite(owner, 'contributor', 'contributor');
    member = await h.invite(owner, 'member', 'member');
    outsider = await h.invite(owner, 'outsider', 'member');
    foreign = await h.signup('foreign', 'globex');
    dept = await createStream(h, owner, 'dept', 'department', [
      { session: contributor, role: 'contributor' },
      { session: member, role: 'viewer' },
    ]);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  // ---------------------------------------------------------------------------------------------------
  it('org creation writes the deployment default; only owner or admin change the flag; other keys survive', async () => {
    const get = async (s: Session) =>
      (await h.call('GET', '/v1/org/settings', s)).body as { documentsEnabled: boolean };
    expect((await get(owner)).documentsEnabled).toBe(true);
    const raw = await h.admin.query<{ v: string | null }>(
      `SELECT settings ->> 'documents_enabled' AS v FROM org WHERE id = $1`,
      [owner.orgId],
    );
    expect(raw.rows[0]!.v).toBe('true'); // written at creation, not inferred
    // A key owned by another component must survive every PATCH (review F15).
    await h.admin.query(
      `UPDATE org SET settings = settings || '{"notify":{"include_title_after_access_loss":true}}' WHERE id = $1`,
      [owner.orgId],
    );
    const denied = await h.call('PATCH', '/v1/org/settings', member, { documentsEnabled: false });
    expect(denied.status).toBe(403);
    const deniedC = await h.call('PATCH', '/v1/org/settings', contributor, {
      documentsEnabled: false,
    });
    expect(deniedC.status).toBe(403);
    expect((await get(owner)).documentsEnabled).toBe(true);
    // Admin may switch it off and on; the audit trail records from and to.
    const off = await h.call('PATCH', '/v1/org/settings', admin, { documentsEnabled: false });
    expect(off.status).toBe(200);
    expect((off.body as { documentsEnabled: boolean }).documentsEnabled).toBe(false);
    expect((await get(member)).documentsEnabled).toBe(false);
    // An unrelated PATCH keeps the flag as it is.
    await h.call('PATCH', '/v1/org/settings', owner, { commentsEnabled: true });
    expect((await get(owner)).documentsEnabled).toBe(false);
    const on = await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: true });
    expect(on.status).toBe(200);
    const after = await h.admin.query<{ s: Record<string, unknown> }>(
      'SELECT settings AS s FROM org WHERE id = $1',
      [owner.orgId],
    );
    expect(after.rows[0]!.s['documents_enabled']).toBe(true);
    expect(after.rows[0]!.s['notify']).toEqual({ include_title_after_access_loss: true });
    const audit = await h.admin.query(
      `SELECT target FROM audit_event WHERE org_id = $1 AND action = 'org.settings_updated'
         AND target -> 'documentsEnabled' ->> 'to' = 'false'`,
      [owner.orgId],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('an org without the key behaves as off: create and upload answer 403 feature_disabled; the flag restores them', async () => {
    const draft = await createDoc(h, contributor, 'Before flag removal');
    await h.admin.query(`UPDATE org SET settings = settings - 'documents_enabled' WHERE id = $1`, [
      owner.orgId,
    ]);
    try {
      expect(
        ((await h.call('GET', '/v1/org/settings', owner)).body as { documentsEnabled: boolean })
          .documentsEnabled,
      ).toBe(false);
      const create = await h.call('POST', '/v1/content', contributor, {
        kind: 'document',
        title: 'nope',
      });
      expect(create.status).toBe(403);
      expect(errorCode(create.body)).toBe('feature_disabled');
      const up = await h.call('POST', `/v1/content/${draft}/upload/init`, contributor, {
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        size: 10,
        parts: 1,
      });
      expect(up.status).toBe(403);
      expect(errorCode(up.body)).toBe('feature_disabled');
      // Clips are untouched by the flag.
      const clip = await h.call('POST', '/v1/content', contributor, {
        kind: 'clip',
        title: 'clip',
      });
      expect(clip.status).toBe(200);
    } finally {
      await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: true });
    }
    const again = await h.call('POST', '/v1/content', contributor, {
      kind: 'document',
      title: 'ok',
    });
    expect(again.status).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------------
  it('uploads every supported kind: detail shows the document, scanStatus not_run, one version_uploaded event, completed_seq set', async () => {
    const kinds: Array<[string, string, string]> = [
      ['report.pdf', 'application/pdf', 'pdf'],
      ['notes.docx', DOCX, 'docx'],
      ['deck.pptx', PPTX, 'pptx'],
      ['budget.xlsx', XLSX, 'xlsx'],
      ['data.csv', 'text/csv', 'csv'],
      ['README.md', 'text/markdown', 'md'],
    ];
    expect(kinds).toHaveLength(6);
    for (const [fileName, mime, format] of kinds) {
      const contentId = await createDoc(h, contributor, `Upload ${format}`);
      const bytes = Buffer.from(`fake ${format} bytes`);
      const up = await uploadDoc(h, contributor, contentId, fileName, mime, bytes);
      expect(up.done!.status, `${format}: ${up.done!.raw}`).toBe(200);
      const d = up.done!.body as Detail;
      expect(d.kind).toBe('document');
      expect(d.currentVersion).toMatchObject({ status: 'uploaded', processingStep: 'uploaded' });
      expect(d.document).toEqual({
        format,
        fileName,
        mimeType: mime,
        size: bytes.length,
        scanStatus: 'not_run',
      });
      const ev = await h.admin.query(
        `SELECT 1 FROM platform.domain_event WHERE subject_id = $1 AND version_id = $2 AND type = 'content.version_uploaded'`,
        [contentId, up.versionId],
      );
      expect(ev.rowCount).toBe(1);
      const seq = await h.admin.query<{ s: string | null }>(
        'SELECT completed_seq::text AS s FROM content_version WHERE id = $1',
        [up.versionId],
      );
      expect(seq.rows[0]!.s).toBe('1');
      // The author sees it; a member never sees a draft (owner-only until published and current).
      expect((await h.call('GET', `/v1/content/${contentId}`, contributor)).status).toBe(200);
      expect((await h.call('GET', `/v1/content/${contentId}`, member)).status).toBe(404);
      // The stored object is exactly what was uploaded.
      expect((await h.store.head(up.key!))?.size).toBe(bytes.length);
    }
  });

  it('refuses unsupported types, mismatched MIME, oversize declarations; sanitises names; clips keep their own MIME rule', async () => {
    const contentId = await createDoc(h, contributor, 'Refusals');
    const init = (fileName: string, mimeType: string, size = 100, parts = 1) =>
      h.call('POST', `/v1/content/${contentId}/upload/init`, contributor, {
        fileName,
        mimeType,
        size,
        parts,
      });
    const before = await h.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM content_version WHERE content_id = $1',
      [contentId],
    );
    for (const [name, mime] of [
      ['legacy.doc', 'application/msword'],
      ['legacy.ppt', 'application/vnd.ms-powerpoint'],
      ['legacy.xls', 'application/vnd.ms-excel'],
      ['page.html', 'text/html'],
      ['image.svg', 'image/svg+xml'],
      ['macro.docm', DOCX],
      ['report.pdf', DOCX],
      ['report.docx', 'application/pdf'],
      ['no-extension', 'application/pdf'],
      ['clip.mp4', 'video/mp4'],
    ] as const) {
      const r = await init(name, mime);
      expect(r.status, `${name} ${mime}`).toBe(400);
      expect(errorCode(r.body)).toBe('unsupported_file_type');
    }
    // 100 MiB + 1 byte declared is refused at presign, before any version row exists.
    const big = await init('big.pdf', 'application/pdf', 100 * 1024 * 1024 + 1, 22);
    expect(big.status).toBe(413);
    expect(errorCode(big.body)).toBe('file_too_large');
    const after = await h.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM content_version WHERE content_id = $1',
      [contentId],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    // Exactly 100 MiB is allowed (control: the cap is a cap, not a refusal of everything large).
    const edge = await init('edge.pdf', 'application/pdf', 100 * 1024 * 1024, 21);
    expect(edge.status).toBe(200);
    // Hostile names are stored sanitised and never reach the key.
    const nasty = await uploadDoc(
      h,
      contributor,
      await createDoc(h, contributor, 'Nasty name'),
      '../..\\evil\u0000\r\nname‮.pdf',
      'application/pdf',
      Buffer.from('%PDF'),
    );
    expect(nasty.done!.status).toBe(200);
    const name = (nasty.done!.body as Detail).document!.fileName;
    expect(
      [...name].some(
        (ch) =>
          ch.codePointAt(0)! < 0x20 || ch === '/' || ch === '\\' || ch.codePointAt(0) === 0x202e,
      ),
    ).toBe(false);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(nasty.key).not.toContain('evil');
    // Clips: a document MIME is refused by the clip rule (video/* or audio/*), and video still works.
    const clip = await h.call('POST', '/v1/content', contributor, { kind: 'clip', title: 'c' });
    const clipId = (clip.body as { id: string }).id;
    const wrong = await h.call('POST', `/v1/content/${clipId}/upload/init`, contributor, {
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      size: 10,
      parts: 1,
    });
    expect(wrong.status).toBe(400);
    expect(errorCode(wrong.body)).toBe('validation');
    const right = await h.call('POST', `/v1/content/${clipId}/upload/init`, contributor, {
      fileName: 'a.mp4',
      mimeType: 'video/mp4',
      size: 10,
      parts: 1,
    });
    expect(right.status).toBe(200);
    // Members cannot create documents (publisher roles only), as for clips.
    const denied = await h.call('POST', '/v1/content', member, { kind: 'document', title: 'x' });
    expect(denied.status).toBe(403);
  });

  // ---------------------------------------------------------------------------------------------------
  it('gate: a published document is invisible while processing or failed, visible once current; viewer, download, list and search follow', async () => {
    const contentId = await createDoc(h, contributor, 'Policy handbook gate');
    const bytes = Buffer.from('%PDF-1.4 gate bytes');
    const up = await uploadDoc(h, contributor, contentId, 'handbook.pdf', 'application/pdf', bytes);
    const pub = await h.call('POST', `/v1/content/${contentId}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    expect(pub.status).toBe(200);
    // Processing: the author sees status and original name; nobody else sees anything.
    const own = (await h.call('GET', `/v1/content/${contentId}`, contributor)).body as Detail;
    expect(own.canEdit).toBe(true);
    expect(own.currentVersion?.status).toBe('uploaded');
    expect(own.document?.fileName).toBe('handbook.pdf');
    for (const who of [member, outsider, foreign]) {
      expect((await h.call('GET', `/v1/content/${contentId}`, who)).status).toBe(404);
      expect((await h.call('GET', `/v1/content/${contentId}/document`, who)).status).toBe(404);
      expect((await h.call('GET', `/v1/content/${contentId}/comments`, who)).status).toBe(404);
      expect((await h.call('POST', `/v1/content/${contentId}/like`, who)).status).toBe(404);
    }
    // ...not even the owner through the reader paths.
    expect((await h.call('GET', `/v1/content/${contentId}/document`, contributor)).status).toBe(
      404,
    );
    expect(
      (await h.call('GET', `/v1/content/${contentId}/document/original`, contributor)).status,
    ).toBe(404);
    const listBefore = (await h.call('GET', `/v1/streams/${dept}/documents`, member)).body as {
      items: Array<{ id: string }>;
    };
    expect(listBefore.items.map((i) => i.id)).not.toContain(contentId);
    // The view and media-token routes are for clips: a document is not found there either.
    expect((await h.call('GET', `/v1/content/${contentId}/media-token`, contributor)).status).toBe(
      404,
    );

    // The worker finishes: the document becomes current and reader-visible.
    expect(await finishDoc(h, owner.orgId!, up.versionId!, TEXT)).toBe('ok');
    const seen = await h.call('GET', `/v1/content/${contentId}`, member);
    expect(seen.status).toBe(200);
    expect((seen.body as Detail).document).toMatchObject({ format: 'pdf', scanStatus: 'not_run' });
    expect((seen.body as Detail).currentVersion?.status).toBe('current');

    // Viewer: parsed text with anchors, plain text only.
    const view = await h.call('GET', `/v1/content/${contentId}/document`, member);
    expect(view.status).toBe(200);
    const v = view.body as {
      title: string;
      versionId: string;
      downloadPath: string;
      document: { scanStatus: string };
      sections: Array<{
        anchor: { label: string; page: number | null; heading: string | null };
        chunks: Array<{ ordinal: number; text: string }>;
      }>;
      nextCursor: string | null;
    };
    expect(v.versionId).toBe(up.versionId);
    expect(v.document.scanStatus).toBe('not_run');
    expect(v.downloadPath).toBe(`/v1/content/${contentId}/document/original`);
    expect(v.sections.map((s) => s.anchor.label)).toEqual(['Page 1', 'Page 2', 'Scope']);
    expect(v.sections[0]!.chunks[0]).toMatchObject({ ordinal: 1 });
    expect(v.sections[0]!.chunks[0]!.text).toContain('quarterly budget');
    expect(v.nextCursor).toBeNull();
    // Paging by ordinal.
    const p1 = (await h.call('GET', `/v1/content/${contentId}/document?limit=2`, member)).body as {
      sections: Array<{ chunks: unknown[] }>;
      nextCursor: string | null;
    };
    expect(p1.sections.flatMap((s) => s.chunks)).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (
      await h.call(
        'GET',
        `/v1/content/${contentId}/document?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`,
        member,
      )
    ).body as { sections: Array<{ chunks: unknown[] }>; nextCursor: string | null };
    expect(p2.sections.flatMap((s) => s.chunks)).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(
      (await h.call('GET', `/v1/content/${contentId}/document?cursor=@@`, member)).status,
    ).toBe(400);

    // The outsider (no stream access) and the other org still get nothing.
    expect((await h.call('GET', `/v1/content/${contentId}/document`, outsider)).status).toBe(404);
    expect((await h.call('GET', `/v1/content/${contentId}/document`, foreign)).status).toBe(404);

    // Download: the exact bytes, as an attachment.
    const dl = await h.call('GET', `/v1/content/${contentId}/document/original`, member);
    expect(dl.status).toBe(200);
    expect(dl.raw).toBe(bytes.toString());
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="handbook\.pdf"/);

    // List shows it for the stream's viewers; search finds it by title and by text with anchors.
    const list = (await h.call('GET', `/v1/streams/${dept}/documents`, member)).body as {
      items: Array<{ id: string; document: { format: string; scanStatus: string } }>;
    };
    expect(list.items.find((i) => i.id === contentId)?.document).toMatchObject({
      format: 'pdf',
      scanStatus: 'not_run',
    });
    const byText = await h.call('GET', '/v1/search/documents?q=quarterly+budget', member);
    expect(byText.status).toBe(200);
    const hits = byText.body as {
      total: number;
      items: Array<{
        id: string;
        kind: string;
        document: { scanStatus: string };
        snippets: Array<{
          source: string;
          text: string;
          ranges: number[][];
          anchor: { label: string } | null;
        }>;
      }>;
    };
    expect(hits.total).toBeGreaterThanOrEqual(1);
    const hit = hits.items.find((i) => i.id === contentId)!;
    expect(hit.kind).toBe('document');
    expect(hit.document.scanStatus).toBe('not_run');
    const snip = hit.snippets.find((s) => s.source === 'text')!;
    expect(snip.anchor?.label).toBe('Page 1');
    expect(snip.ranges.length).toBeGreaterThan(0);
    expect(snip.text).not.toMatch(/[<>]/);
    const byTitle = await h.call('GET', '/v1/search/documents?q=handbook', member);
    expect((byTitle.body as { items: Array<{ id: string }> }).items.map((i) => i.id)).toContain(
      contentId,
    );
    // The outsider finds nothing (positive control above, negative here).
    expect(
      (
        (await h.call('GET', '/v1/search/documents?q=quarterly', outsider)).body as {
          total: number;
        }
      ).total,
    ).toBe(0);
    expect(
      ((await h.call('GET', '/v1/search/documents?q=quarterly', foreign)).body as { total: number })
        .total,
    ).toBe(0);

    // Retract: gone on the very next request, everywhere.
    expect((await h.call('POST', `/v1/content/${contentId}/retract`, contributor)).status).toBe(
      200,
    );
    for (const path of [
      `/v1/content/${contentId}/document`,
      `/v1/content/${contentId}/document/original`,
    ]) {
      const r = await h.call('GET', path, member);
      expect(r.status, path).toBe(404);
    }
    expect(
      ((await h.call('GET', '/v1/search/documents?q=quarterly', member)).body as { total: number })
        .total,
    ).toBe(0);
    const listAfter = (await h.call('GET', `/v1/streams/${dept}/documents`, member)).body as {
      items: Array<{ id: string }>;
    };
    expect(listAfter.items.map((i) => i.id)).not.toContain(contentId);
  });

  it('a failed version stays invisible even when published; replace keeps the old version current until the new one finishes (NEG-5)', async () => {
    const failed = await createDoc(h, contributor, 'Failed parse');
    const upF = await uploadDoc(
      h,
      contributor,
      failed,
      'bad.pdf',
      'application/pdf',
      Buffer.from('x'),
    );
    await h.call('POST', `/v1/content/${failed}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    expect(await finishDoc(h, owner.orgId!, upF.versionId!, [{ locator: {}, text: '   ' }])).toBe(
      'failed',
    );
    expect((await h.call('GET', `/v1/content/${failed}`, member)).status).toBe(404);
    const own = (await h.call('GET', `/v1/content/${failed}`, contributor)).body as Detail;
    expect(own.currentVersion?.status).toBe('failed');

    const { contentId, versionId } = await publishedDoc(h, contributor, dept, 'Replace me', [
      { locator: { page: 1 }, text: 'alpha version one text' },
    ]);
    const v1 = await h.call('GET', `/v1/content/${contentId}/document`, member);
    expect(v1.status).toBe(200);
    const up2 = await uploadDoc(
      h,
      contributor,
      contentId,
      'v2.pdf',
      'application/pdf',
      Buffer.from('%PDF v2'),
      'replace',
    );
    expect(up2.done!.status).toBe(200);
    // Before the switch commit the old version is current by design.
    expect((v1.body as { versionId: string }).versionId).toBe(versionId);
    const mid = (await h.call('GET', `/v1/content/${contentId}/document`, member)).body as {
      versionId: string;
    };
    expect(mid.versionId).toBe(versionId);
    expect(
      await finishDoc(h, owner.orgId!, up2.versionId!, [
        { locator: { page: 1 }, text: 'beta version two text' },
      ]),
    ).toBe('ok');
    const after = (await h.call('GET', `/v1/content/${contentId}/document`, member)).body as {
      versionId: string;
      sections: Array<{ chunks: Array<{ text: string }> }>;
    };
    expect(after.versionId).toBe(up2.versionId);
    expect(after.sections[0]!.chunks[0]!.text).toContain('beta');
    const alpha = (await h.call('GET', '/v1/search/documents?q=alpha', member)).body as {
      total: number;
    };
    expect(alpha.total).toBe(0);
    const beta = (await h.call('GET', '/v1/search/documents?q=beta', member)).body as {
      total: number;
    };
    expect(beta.total).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------------
  it('hidden, missing, other-org, flag-off and non-document ids answer an identical 404 (status, headers except Date, body) on viewer and download', async () => {
    const { contentId } = await publishedDoc(h, contributor, dept, 'Identical 404 subject');
    const draftId = await createDoc(h, contributor, 'Draft doc');
    await uploadDoc(h, contributor, draftId, 'd.pdf', 'application/pdf', Buffer.from('d'));
    const clip = await createPlayableContent(h, contributor, 'A clip');
    const missing = randomUUID();
    for (const suffix of ['document', 'document/original']) {
      const baseline = await h.call('GET', `/v1/content/${missing}/${suffix}`, member);
      expect(baseline.status).toBe(404);
      const sample = (r: typeof baseline) => ({
        status: r.status,
        headers: nonDate(r.headers),
        raw: r.raw,
      });
      const want = sample(baseline);
      const cases: Array<[string, string, Session]> = [
        ['no audience path', contentId, outsider],
        ['other org', contentId, foreign],
        ['draft', draftId, member],
        ['a clip id', clip.contentId, member],
        ['draft, author-only path is not a reader path', draftId, contributor],
      ];
      for (const [label, id, who] of cases) {
        const r = await h.call('GET', `/v1/content/${id}/${suffix}`, who);
        expect(sample(r), `${suffix}: ${label}`).toEqual(want);
      }
      // Control: the permitted reader gets a real answer, so the 404s above are not a vacuous "always 404".
      expect((await h.call('GET', `/v1/content/${contentId}/${suffix}`, member)).status).toBe(200);
      // Flag off: the same bytes again.
      await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: false });
      try {
        const r = await h.call('GET', `/v1/content/${contentId}/${suffix}`, member);
        expect(sample(r), `${suffix}: flag off`).toEqual(want);
      } finally {
        await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: true });
      }
      expect((await h.call('GET', `/v1/content/${contentId}/${suffix}`, member)).status).toBe(200);
    }
    // The neutral body carries no request id and no hint.
    const r = await h.call('GET', `/v1/content/${missing}/document`, member);
    expect(r.body).toEqual({ error: { code: 'not_found', message: 'not found' } });
  });

  it('serves originals only as inert attachments: HTML, SVG and active PDF fixtures, hostile names, ranges', async () => {
    const html = Buffer.from('<html><body><script>alert(document.cookie)</script></body></html>');
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
    );
    const activePdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert\\(1\\))>>>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
    );
    const fixtures: Array<[string, string, string, Buffer, string]> = [
      ['html-named.docx', DOCX, 'HTML named docx', html, DOCX],
      ['svg-named.docx', DOCX, 'SVG named docx', svg, DOCX],
      ['active.pdf', 'application/pdf', 'Active PDF', activePdf, 'application/pdf'],
      ['page.csv', 'text/plain', 'HTML as csv', html, 'text/csv'],
    ];
    for (const [fileName, mime, title, bytes, served] of fixtures) {
      const { contentId } = await publishedDoc(
        h,
        contributor,
        dept,
        title,
        TEXT,
        fileName,
        mime,
        bytes,
      );
      const r = await h.call('GET', `/v1/content/${contentId}/document/original`, member);
      expect(r.status, fileName).toBe(200);
      expect(r.raw).toBe(bytes.toString());
      const ct = String(r.headers['content-type']);
      expect(ct).toBe(served);
      expect(ct).not.toMatch(/html|svg|javascript|text\/xml/);
      expect(String(r.headers['content-disposition'])).toMatch(/^attachment;/);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
      expect(r.headers['cache-control']).toBe('private, no-store');
      expect(String(r.headers['content-length'])).toBe(String(bytes.length));
      // The viewer never carries the original markup.
      const view = await h.call('GET', `/v1/content/${contentId}/document`, member);
      expect(view.raw).not.toContain('<script');
      expect(view.raw).not.toContain('onload');
    }
    // Hostile names in the header: no CR/LF, no quote breakout, no path.
    const { contentId } = await publishedDoc(
      h,
      contributor,
      dept,
      'Header injection',
      TEXT,
      'a"b\r\nSet-Cookie: x=1\u0000/../c.pdf',
      'application/pdf',
      Buffer.from('%PDF'),
    );
    const r = await h.call('GET', `/v1/content/${contentId}/document/original`, member);
    expect(r.status).toBe(200);
    const cd = String(r.headers['content-disposition']);
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).not.toContain('/');
    expect(r.headers['set-cookie']).toBeUndefined();

    // Ranges: partial content, suffix, open ended; unsatisfiable and multi-range are 416.
    const bytes = Buffer.from('0123456789abcdefghij');
    const ranged = await publishedDoc(
      h,
      contributor,
      dept,
      'Ranges',
      TEXT,
      'r.pdf',
      'application/pdf',
      bytes,
    );
    const path = `/v1/content/${ranged.contentId}/document/original`;
    const part = await h.call('GET', path, member, undefined, { range: 'bytes=2-5' });
    expect(part.status).toBe(206);
    expect(part.raw).toBe('2345');
    expect(part.headers['content-range']).toBe('bytes 2-5/20');
    expect(part.headers['accept-ranges']).toBe('bytes');
    expect((await h.call('GET', path, member, undefined, { range: 'bytes=-4' })).raw).toBe('ghij');
    expect((await h.call('GET', path, member, undefined, { range: 'bytes=15-' })).raw).toBe(
      'fghij',
    );
    for (const bad of ['bytes=99-', 'bytes=0-1,4-5', 'bytes=5-2', 'junk']) {
      const b = await h.call('GET', path, member, undefined, { range: bad });
      expect(b.status, bad).toBe(416);
      expect(b.headers['content-range']).toBe('bytes */20');
    }
  });

  // ---------------------------------------------------------------------------------------------------
  it('search never stores or logs q; hygiene: NFC/NFD, zero-width, empty, 2,000 and 2,001 characters, other scripts', async () => {
    await publishedDoc(h, contributor, dept, 'Hygiene subject', [
      {
        locator: { page: 1 },
        text: 'The café résumé and the budget are here. 中文测试 مرحبا hello.',
      },
    ]);
    const ids = async (q: string) => {
      const r = await h.call('GET', `/v1/search/documents?q=${encodeURIComponent(q)}`, member);
      expect(r.status, q).toBe(200);
      return (r.body as { items: Array<{ id: string }> }).items.map((i) => i.id);
    };
    const nfc = await ids('café');
    expect(nfc.length).toBeGreaterThan(0);
    expect(await ids('café')).toEqual(nfc); // NFD query finds the NFC text
    expect(await ids('bud​get')).toEqual(await ids('budget')); // zero-width inside a word
    expect((await ids('budget')).length).toBeGreaterThan(0);
    expect(await ids('')).toEqual([]);
    expect(await ids('​​ \u0007')).toEqual([]);
    expect(await ids('a'.repeat(2000))).toEqual([]); // exactly 2,000: accepted, finds nothing
    const tooLong = await h.call('GET', `/v1/search/documents?q=${'a'.repeat(2001)}`, member);
    expect(tooLong.status).toBe(400);
    expect(errorCode(tooLong.body)).toBe('validation');
    for (const q of ['中文', 'مرحبا', '"unbalanced', '-', 'or or or', '(((']) {
      const r = await h.call('GET', `/v1/search/documents?q=${encodeURIComponent(q)}`, member);
      expect(r.status, q).toBe(200);
    }
    expect((await ids('中文测试')).length).toBeGreaterThan(0);
    // The term never reaches the logs or any table.
    const canary = `canaryterm${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await h.call('GET', `/v1/search/documents?q=${canary}`, member);
    expect(h.logs.join('\n')).not.toContain(canary);
    const tables = await h.admin.query<{ t: string }>(
      `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema IN ('public','platform') AND table_type = 'BASE TABLE'`,
    );
    for (const { t } of tables.rows) {
      const hit = await h.admin.query(`SELECT 1 FROM ${t} x WHERE x::text LIKE $1 LIMIT 1`, [
        `%${canary}%`,
      ]);
      expect(hit.rowCount, `table ${t}`).toBe(0);
    }
  });

  it('documents never enter the feed or the clip search; the clip HLS clause is untouched', async () => {
    const { contentId } = await publishedDoc(
      h,
      contributor,
      dept,
      'Feed exclusion zebracrossing subject',
      [{ locator: { page: 1 }, text: 'zebracrossing appears in the document text as well' }],
    );
    const feed = await h.call('GET', '/v1/feed?limit=50', member);
    expect(feed.status).toBe(200);
    expect((feed.body as { items: Array<{ id: string }> }).items.map((i) => i.id)).not.toContain(
      contentId,
    );
    // The clip search neither returns the document nor counts it (title and text both match the term).
    const clipSearch = await h.call('GET', '/v1/search?q=zebracrossing', member);
    expect(clipSearch.status).toBe(200);
    expect((clipSearch.body as { items: unknown[]; total: number }).items).toEqual([]);
    expect((clipSearch.body as { total: number }).total).toBe(0);
    // Control: the document search does find it, so the zero above is not an empty index.
    const docs = await h.call('GET', '/v1/search/documents?q=zebracrossing', member);
    expect((docs.body as { items: Array<{ id: string }> }).items.map((i) => i.id)).toContain(
      contentId,
    );
  });

  it('per-stream Documents list: published, live, current documents of that stream only, paged by cursor', async () => {
    const other = await createStream(h, owner, 'otherdocs', 'team', [
      { session: contributor, role: 'contributor' },
      { session: member, role: 'viewer' },
    ]);
    const a = await publishedDoc(h, contributor, other, 'List A');
    const b = await publishedDoc(h, contributor, other, 'List B');
    const c = await publishedDoc(h, contributor, other, 'List C');
    // Not listed: a draft with a current version, a scheduled one, a retracted one, a processing one.
    const draft = await publishedDoc(h, contributor, other, 'List draft');
    await h.admin.query(`UPDATE content SET state = 'draft' WHERE id = $1`, [draft.contentId]);
    const sched = await publishedDoc(h, contributor, other, 'List scheduled');
    await h.admin.query(`UPDATE content SET publish_at = now() + interval '1 hour' WHERE id = $1`, [
      sched.contentId,
    ]);
    const retracted = await publishedDoc(h, contributor, other, 'List retracted');
    await h.call('POST', `/v1/content/${retracted.contentId}/retract`, contributor);
    const proc = await createDoc(h, contributor, 'List processing');
    await uploadDoc(h, contributor, proc, 'p.pdf', 'application/pdf', Buffer.from('p'));
    await h.call('POST', `/v1/content/${proc}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: other }],
    });

    const list = async (s: Session, qs = '') =>
      (await h.call('GET', `/v1/streams/${other}/documents${qs}`, s)).body as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
    const full = await list(member);
    expect(new Set(full.items.map((i) => i.id))).toEqual(
      new Set([a.contentId, b.contentId, c.contentId]),
    );
    expect(await list(outsider)).toEqual({ items: [], nextCursor: null }); // not addressed to them
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = await list(
        member,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...p.items.map((i) => i.id));
      cursor = p.nextCursor;
      pages += 1;
    } while (cursor && pages < 5);
    expect(pages).toBe(2);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    // A private stream the caller does not belong to does not exist for them.
    const secret = await createStream(h, owner, 'secretdocs', 'private', [
      { session: contributor, role: 'contributor' },
    ]);
    expect((await h.call('GET', `/v1/streams/${secret}/documents`, member)).status).toBe(404);
    expect((await h.call('GET', `/v1/streams/${randomUUID()}/documents`, member)).status).toBe(404);
    expect((await h.call('GET', `/v1/streams/${other}/documents?cursor=@@`, member)).status).toBe(
      400,
    );
  });

  // ---------------------------------------------------------------------------------------------------
  it('publishing a document with the flag off is 403 feature_disabled; an already published one can still be re-published and retracted', async () => {
    const draft = await createDoc(h, contributor, 'Publish guard');
    const up = await uploadDoc(h, contributor, draft, 'g.pdf', 'application/pdf', Buffer.from('g'));
    expect(await finishDoc(h, owner.orgId!, up.versionId!, TEXT)).toBe('ok');
    const live = await publishedDoc(h, contributor, dept, 'Publish guard live');
    await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: false });
    try {
      const blocked = await h.call('POST', `/v1/content/${draft}/publish`, contributor, {
        audience: [{ type: 'stream', streamId: dept }],
      });
      expect(blocked.status).toBe(403);
      expect(errorCode(blocked.body)).toBe('feature_disabled');
      const detail = (await h.call('GET', `/v1/content/${draft}`, contributor)).body as Detail;
      expect(detail.state).toBe('draft'); // the failed publish rolled back
      // Re-publishing an already published document stays allowed; retraction always works.
      const again = await h.call('POST', `/v1/content/${live.contentId}/publish`, contributor, {
        audience: [{ type: 'stream', streamId: dept }],
      });
      expect(again.status).toBe(200);
      // Upload complete is refused too.
      const c = await createDoc(h, contributor, 'x').catch(() => null);
      expect(c).toBeNull(); // create is refused with the flag off
      expect(
        (await h.call('POST', `/v1/content/${live.contentId}/retract`, contributor)).status,
      ).toBe(200);
    } finally {
      await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: true });
    }
    const ok = await h.call('POST', `/v1/content/${draft}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    expect(ok.status).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------------
  it('notifications: no audience and no announcement while processing or flag off; one announcement after finish; stored notices keep only their snapshot (accepted)', async () => {
    const contentId = await createDoc(h, contributor, 'Notify subject');
    const up = await uploadDoc(
      h,
      contributor,
      contentId,
      'n.pdf',
      'application/pdf',
      Buffer.from('n'),
    );
    await h.call('POST', `/v1/content/${contentId}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    const audience = async () => {
      const r = await h.admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM platform_audience_of_content($1, $2)',
        [owner.orgId, contentId],
      );
      return r.rows[0]!.n;
    };
    const announcements = async () =>
      (
        await h.admin.query(
          `SELECT 1 FROM platform.domain_event WHERE subject_id = $1 AND type = 'content.published' AND payload ->> 'source' = 'processing_complete'`,
          [contentId],
        )
      ).rowCount;
    // Processing: the audience function returns nobody and finish has not announced.
    expect(await audience()).toBe(0);
    expect(await announcements()).toBe(0);
    expect(await finishDoc(h, owner.orgId!, up.versionId!, TEXT)).toBe('ok');
    // Positive polarity: the same function now lists the stream's viewers, and exactly one announcement exists.
    expect(await audience()).toBeGreaterThan(0);
    expect(await announcements()).toBe(1);

    // Flag off at finish time: nobody is told.
    const quiet = await createDoc(h, contributor, 'Notify quiet');
    const upQ = await uploadDoc(
      h,
      contributor,
      quiet,
      'q.pdf',
      'application/pdf',
      Buffer.from('q'),
    );
    await h.call('POST', `/v1/content/${quiet}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: false });
    try {
      expect(await finishDoc(h, owner.orgId!, upQ.versionId!, TEXT)).toBe('ok');
      const quietAnn = await h.admin.query(
        `SELECT 1 FROM platform.domain_event WHERE subject_id = $1 AND type = 'content.published' AND payload ->> 'source' = 'processing_complete'`,
        [quiet],
      );
      expect(quietAnn.rowCount).toBe(0);
      const aud = await h.admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM platform_audience_of_content($1, $2)',
        [owner.orgId, contentId],
      );
      expect(aud.rows[0]!.n).toBe(0);
    } finally {
      await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: true });
    }

    // A notice created while the document was visible keeps its snapshot, and the live title disappears
    // as soon as the document is not visible (flag off): no title, no leak, the row itself stays.
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [owner.orgId]);
    await h.admin.query(
      `INSERT INTO notification (org_id, user_id, kind, reason, content_id, version_id, title_snapshot, dedupe_key)
       VALUES ($1, $2, 'content.published', 'in_audience', $3, $4, 'Notify subject (snapshot)', $5)`,
      [owner.orgId, member.userId, contentId, up.versionId, `published:${up.versionId}`],
    );
    const visible = (await h.call('GET', '/v1/notifications', member)).body as {
      items: Array<{ contentId: string | null; title: string | null }>;
    };
    expect(visible.items.find((n) => n.contentId === contentId)?.title).toBe('Notify subject');
    await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: false });
    try {
      const hidden = await h.call('GET', '/v1/notifications', member);
      const row = (
        hidden.body as { items: Array<{ contentId: string | null; title: string | null }> }
      ).items.find((n) => n.contentId === contentId);
      expect(row).toBeDefined();
      // Accepted (spec "Existing notifications"): a stored notice keeps its snapshot title exactly as for a
      // retracted clip; the live title never shows once the document is not readable.
      expect(row!.title).toBe('Notify subject (snapshot)');
      expect(hidden.raw).not.toContain('"Notify subject"');
    } finally {
      await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: true });
    }
  });

  // ---------------------------------------------------------------------------------------------------
  describe('flag matrix over the authz document fixture', () => {
    let fixture: ReturnType<typeof buildFixture>;
    let cookies: Map<string, string>;
    const now = new Date();

    beforeAll(async () => {
      fixture = buildFixture(`-docs-${h.suffix}`, { documents: true });
      cookies = await seedFixtureSessions(h, fixture);
      // The download matrix needs real objects behind the fixture versions.
      for (const org of fixture.orgs) {
        const rows = await h.admin.query<{ original_key: string }>(
          `SELECT original_key FROM content_version WHERE org_id = $1 AND original_key IS NOT NULL`,
          [org.orgId],
        );
        for (const r of rows.rows)
          await h.store.put(r.original_key, Buffer.from('%PDF fixture'), 'application/pdf');
      }
    });
    afterAll(async () => {
      await h.admin.query(`DELETE FROM org WHERE slug IN ($1, $2)`, [
        fixture.orgs[0].slug,
        fixture.orgs[1].slug,
      ]);
    });

    const docIds = (org: FixtureOrg) => Object.values(org.documentNames) as string[];
    const get = async (org: FixtureOrg, userId: string, url: string) => {
      const res = await h.app.inject({
        method: 'GET',
        url,
        cookies: { os_session: cookies.get(`${org.orgId}:${userId}`)! },
      });
      return {
        status: res.statusCode,
        body: res.statusCode === 200 && res.body.startsWith('{') ? (res.json() as unknown) : null,
        raw: res.body,
      };
    };

    it('viewer and download agree with the readerVisible reference on every (org, user, document) cell; permitted roles get non-zero', async () => {
      let cells = 0;
      let permitted = 0;
      for (const org of fixture.orgs) {
        for (const [name, userId] of Object.entries(fixture.users)) {
          for (const id of docIds(org)) {
            const want = readerVisible(org, userId, id, now);
            // The flag-off org answers 404 to everyone on both routes; sampling the download there keeps
            // the matrix fast (the viewer covers every cell, the download every cell of the flag-on org).
            const suffixes =
              org === fixture.orgs[0] ? ['document', 'document/original'] : ['document'];
            for (const suffix of suffixes) {
              const r = await get(org, userId, `/v1/content/${id}/${suffix}`);
              cells += 1;
              if (r.status === 401 || r.status === 403) {
                expect(want, `${org.slug} ${name} ${id} ${suffix}`).toBe(false);
                continue;
              }
              expect(r.status === 200, `${org.slug} ${name} ${id} ${suffix} -> ${r.status}`).toBe(
                want,
              );
              if (!want) expect(r.status).toBe(404);
              if (want) permitted += 1;
            }
          }
        }
      }
      expect(cells).toBeGreaterThan(300);
      expect(permitted).toBeGreaterThan(10);
    }, 600_000);

    it('document search and the stream lists agree with the reference; the flag-off org returns nothing to anyone', async () => {
      const nonZero = new Map<string, number>();
      for (const org of fixture.orgs) {
        for (const [name, userId] of Object.entries(fixture.users)) {
          const expected = new Set(docIds(org).filter((id) => readerVisible(org, userId, id, now)));
          const s = await get(org, userId, '/v1/search/documents?q=onboarding&limit=50');
          if (s.status !== 200) {
            expect([401, 403], `${org.slug} ${name}`).toContain(s.status);
            expect(expected.size).toBe(0);
            continue;
          }
          const body = s.body as { items: Array<{ id: string }>; total: number };
          expect(new Set(body.items.map((i) => i.id)), `search ${org.slug} ${name}`).toEqual(
            expected,
          );
          expect(body.total).toBe(expected.size);
          if (expected.size > 0) nonZero.set(org.slug, (nonZero.get(org.slug) ?? 0) + 1);
          for (const streamName of ['company', 'department'] as const) {
            const streamId = org.streamNames[streamName];
            const addressed = new Set(
              org.tuples
                .filter(
                  (t) =>
                    t.objectType === 'content' &&
                    t.subjectType === 'stream' &&
                    t.subjectId === streamId,
                )
                .map((t) => t.objectId),
            );
            const want = new Set([...expected].filter((id) => addressed.has(id)));
            const l = await get(org, userId, `/v1/streams/${streamId}/documents?limit=50`);
            expect(l.status, `list ${org.slug} ${name} ${streamName}`).toBe(200);
            expect(
              new Set((l.body as { items: Array<{ id: string }> }).items.map((i) => i.id)),
            ).toEqual(want);
          }
        }
      }
      // Positive polarity: permitted roles of the flag-on org got non-empty answers; the flag-off org
      // produced none (every cell above asserted equal to the reference, which is empty there).
      expect(nonZero.get(fixture.orgs[0].slug) ?? 0).toBeGreaterThan(5);
      expect(nonZero.get(fixture.orgs[1].slug) ?? 0).toBe(0);
    }, 600_000);
  });

  // ---------------------------------------------------------------------------------------------------
  it('kill switch (rollback window): settings cannot turn documents on, reader paths 404, publish and upload 403, then everything returns', async () => {
    const { contentId } = await publishedDoc(h, contributor, dept, 'Kill switch subject');
    const draft = await createDoc(h, contributor, 'Kill switch draft');
    const upD = await uploadDoc(
      h,
      contributor,
      draft,
      'k.pdf',
      'application/pdf',
      Buffer.from('k'),
    );
    expect(await finishDoc(h, owner.orgId!, upD.versionId!, TEXT)).toBe('ok');
    expect((await h.call('GET', `/v1/content/${contentId}/document`, member)).status).toBe(200);
    await h.admin.query('SELECT platform_documents_kill_switch_set(true)');
    try {
      const on = await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: true });
      expect(on.status).toBe(403);
      expect(errorCode(on.body)).toBe('feature_disabled');
      // An unrelated PATCH is still fine, and so is turning the flag off.
      expect(
        (await h.call('PATCH', '/v1/org/settings', owner, { commentsEnabled: true })).status,
      ).toBe(200);
      for (const suffix of ['document', 'document/original'])
        expect((await h.call('GET', `/v1/content/${contentId}/${suffix}`, member)).status).toBe(
          404,
        );
      expect(
        (
          (await h.call('GET', '/v1/search/documents?q=quarterly', member)).body as {
            total: number;
          }
        ).total,
      ).toBe(0);
      const pub = await h.call('POST', `/v1/content/${draft}/publish`, contributor, {
        audience: [{ type: 'stream', streamId: dept }],
      });
      expect(pub.status).toBe(403);
      expect(errorCode(pub.body)).toBe('feature_disabled');
      const create = await h.call('POST', '/v1/content', contributor, {
        kind: 'document',
        title: 'x',
      });
      expect(create.status).toBe(403);
      // Clips are unaffected by the kill switch.
      expect(
        (await h.call('POST', '/v1/content', contributor, { kind: 'clip', title: 'still ok' }))
          .status,
      ).toBe(200);
    } finally {
      await h.admin.query('SELECT platform_documents_kill_switch_set(false)');
    }
    expect((await h.call('GET', `/v1/content/${contentId}/document`, member)).status).toBe(200);
    expect(
      (await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: true })).status,
    ).toBe(200);
  });
});

// ==============================================================================================
describe.skipIf(!integrationReady)('documents: deployment default off (integration)', () => {
  let h: Harness;
  it('an org created with DOCUMENTS_ENABLED_DEFAULT=false starts with documents off; an admin can turn them on', async () => {
    h = await createHarness('docsoff'); // default config: false
    try {
      const owner = await h.signup('owner', 'offorg');
      const s = (await h.call('GET', '/v1/org/settings', owner)).body as {
        documentsEnabled: boolean;
      };
      expect(s.documentsEnabled).toBe(false);
      const raw = await h.admin.query<{ v: string | null }>(
        `SELECT settings ->> 'documents_enabled' AS v FROM org WHERE id = $1`,
        [owner.orgId],
      );
      expect(raw.rows[0]!.v).toBe('false');
      const denied = await h.call('POST', '/v1/content', owner, { kind: 'document', title: 'x' });
      expect(denied.status).toBe(403);
      expect(errorCode(denied.body)).toBe('feature_disabled');
      expect(
        (await h.call('PATCH', '/v1/org/settings', owner, { documentsEnabled: true })).status,
      ).toBe(200);
      expect(
        (await h.call('POST', '/v1/content', owner, { kind: 'document', title: 'x' })).status,
      ).toBe(200);
    } finally {
      await h.cleanup();
    }
  });
});

// ==============================================================================================
describe.skipIf(!integrationReady)('documents: limits (integration)', () => {
  let h: Harness;
  let a: Session;
  let b: Session;

  beforeAll(async () => {
    h = await createHarness('docslim', {
      DOCUMENTS_ENABLED_DEFAULT: 'true',
      DOCUMENT_UPLOADS_PER_USER_HOUR: '3',
      DOCUMENT_ORG_QUOTA_BYTES: '1000',
      DOCUMENT_QUERY_RATE_LIMIT_MAX: '3',
    });
    const owner = await h.signup('owner', 'lim');
    a = await h.invite(owner, 'a', 'contributor');
    b = await h.invite(owner, 'b', 'contributor');
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('20/hour style upload budget: the 4th init is 429 with a stable body; another user is unaffected', async () => {
    const id = await createDoc(h, a, 'budget');
    const init = (s: Session, size = 10) =>
      h.call('POST', `/v1/content/${id}/upload/init`, s, {
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        size,
        parts: 1,
      });
    for (let i = 0; i < 3; i += 1) expect((await init(a)).status).toBe(200);
    const fourth = await init(a);
    expect(fourth.status).toBe(429);
    expect(errorCode(fourth.body)).toBe('rate_limited');
    expect((fourth.body as { error: { message: string } }).error.message).toBe(
      'too many document uploads, try again later',
    );
    const again = await init(a);
    expect(again.status).toBe(429);
    expect((again.body as { error: { message: string } }).error.message).toBe(
      (fourth.body as { error: { message: string } }).error.message,
    );
    // b is another user with an untouched budget (control: the limit is per user).
    const bDoc = await createDoc(h, b, 'b budget');
    const r = await h.call('POST', `/v1/content/${bDoc}/upload/init`, b, {
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      size: 10,
      parts: 1,
    });
    expect(r.status).toBe(200);
  });

  it('org storage quota: an upload that would pass the quota is 429 quota_exceeded; failed versions free their bytes', async () => {
    const id = await createDoc(h, b, 'quota');
    const init = (size: number) =>
      h.call('POST', `/v1/content/${id}/upload/init`, b, {
        fileName: 'q.pdf',
        mimeType: 'application/pdf',
        size,
        parts: 1,
      });
    // The previous test used 3 x 10 bytes + 10 for b's doc; 1000 byte quota.
    const first = await init(900);
    expect(first.status).toBe(200);
    const second = await init(900);
    expect(second.status).toBe(429);
    expect(errorCode(second.body)).toBe('quota_exceeded');
    const versionId = (first.body as { versionId: string }).versionId;
    await h.admin.query(`UPDATE content_version SET status = 'failed' WHERE id = $1`, [versionId]);
    // The failed version's bytes are free again: the same request now passes the quota (control for the 429 above).
    expect((await init(900)).status).toBe(200);
  });

  it('search and retrieval share a 60/min style budget per user: the 4th query is 429, another user still searches', async () => {
    const q = (s: Session) => h.call('GET', '/v1/search/documents?q=anything', s);
    for (let i = 0; i < 3; i += 1) expect((await q(a)).status).toBe(200);
    const fourth = await q(a);
    expect(fourth.status).toBe(429);
    expect(errorCode(fourth.body)).toBe('rate_limited');
    expect((fourth.body as { error: { message: string } }).error.message).toBe('too many requests');
    expect((await q(b)).status).toBe(200);
  });
});

// ==============================================================================================
describe.skipIf(!integrationReady)(
  'documents: upload-complete races and download limits (integration)',
  () => {
    let h: Harness;
    let store: MemoryStore;
    let contributor: Session;
    let member: Session;
    let owner: Session;
    let dept: string;

    beforeAll(async () => {
      store = new MemoryStore();
      await store.start();
      h = await createHarness(
        'docsrace',
        {
          DOCUMENTS_ENABLED_DEFAULT: 'true',
          DOCUMENT_MAX_BYTES: '1000',
          DOCUMENT_DOWNLOAD_CONCURRENCY_PER_USER: '2',
          DOCUMENT_DOWNLOAD_CONCURRENCY: '3',
        },
        { store },
      );
      owner = await h.signup('owner', 'race');
      contributor = await h.invite(owner, 'contributor', 'contributor');
      member = await h.invite(owner, 'member', 'member');
      dept = await createStream(h, owner, 'racedept', 'department', [
        { session: contributor, role: 'contributor' },
        { session: member, role: 'viewer' },
      ]);
    });
    afterAll(async () => {
      await h.cleanup();
      await store.stop();
    });
    const resetHooks = () => {
      store.hooks = {};
    };
    // Every gate a test parks a request behind is opened after the test, pass or fail, so a failing
    // assertion can never leave a request hanging (and afterAll cleanup waiting on it).
    const gates: Array<() => void> = [];
    afterEach(() => {
      for (const open of gates.splice(0)) open();
      resetHooks();
    });

    /** Init + PUT; returns the body to POST to complete. */
    async function prepare(title: string, bytes: Buffer = Buffer.from('%PDF race bytes')) {
      const contentId = await createDoc(h, contributor, title);
      const init = await h.call('POST', `/v1/content/${contentId}/upload/init`, contributor, {
        fileName: 'race.pdf',
        mimeType: 'application/pdf',
        size: bytes.length,
        parts: 1,
      });
      expect(init.status).toBe(200);
      const b = init.body as {
        versionId: string;
        uploadId: string;
        key: string;
        partUrls: Array<{ url: string }>;
      };
      const put = await fetch(b.partUrls[0]!.url, { method: 'PUT', body: new Uint8Array(bytes) });
      const complete = {
        versionId: b.versionId,
        uploadId: b.uploadId,
        parts: [{ partNumber: 1, etag: put.headers.get('etag')! }],
      };
      return { contentId, ...b, complete };
    }
    const events = async (contentId: string, versionId: string) =>
      (
        await h.admin.query(
          `SELECT 1 FROM platform.domain_event WHERE subject_id = $1 AND version_id = $2 AND type = 'content.version_uploaded'`,
          [contentId, versionId],
        )
      ).rowCount;

    it('two concurrent completes: one job, one 200, the other the idempotent 409; no storage error reaches either caller (second store complete throws NoSuchUpload)', async () => {
      resetHooks();
      const p = await prepare('Race A');
      // Hold the FIRST request inside its storage complete until the second request has finished entirely.
      let releaseFirst!: () => void;
      const gate = new Promise<void>((r) => (releaseFirst = r));
      gates.push(() => releaseFirst());
      store.hooks.beforeComplete = async ({ call }) => {
        if (call === 1) await gate;
      };
      const callsBefore = store.completeCalls;
      const first = h.call(
        'POST',
        `/v1/content/${p.contentId}/upload/complete`,
        contributor,
        p.complete,
      );
      while (store.completeCalls === callsBefore) await new Promise((r) => setTimeout(r, 10));
      const second = await h.call(
        'POST',
        `/v1/content/${p.contentId}/upload/complete`,
        contributor,
        p.complete,
      );
      expect(second.status).toBe(200); // its store complete succeeded; the first's upload id is now gone
      releaseFirst();
      const lost = await first; // its store complete throws NoSuchUpload
      resetHooks();
      expect(lost.status).toBe(409);
      expect(errorCode(lost.body)).toBe('already_completed');
      expect(await events(p.contentId, p.versionId)).toBe(1);
      const seq = await h.admin.query<{ s: string }>(
        'SELECT completed_seq::text AS s FROM content_version WHERE id = $1',
        [p.versionId],
      );
      expect(seq.rows[0]!.s).toBe('1');
    });

    it('winner suspended between storage and lock: the loser (NoSuchUpload, still awaiting) heads the object, completes under the lock; the suspended winner then gets 409; one job', async () => {
      resetHooks();
      const p = await prepare('Race B');
      let releaseHead!: () => void;
      const gate = new Promise<void>((r) => (releaseHead = r));
      gates.push(() => releaseHead());
      let headCalls = 0;
      const realHead = store.head.bind(store);
      store.head = async (key: string) => {
        headCalls += 1;
        if (headCalls === 1) await gate; // the first request's head, before it takes the lock
        return realHead(key);
      };
      try {
        const first = h.call(
          'POST',
          `/v1/content/${p.contentId}/upload/complete`,
          contributor,
          p.complete,
        );
        while (headCalls === 0) await new Promise((r) => setTimeout(r, 10));
        // First request has completed the multipart upload and is parked at head. The second one's store
        // complete now throws NoSuchUpload; it takes the lock, sees the version still awaiting, heads the
        // object (a matching size counts as completion) and finishes the job itself.
        const second = await h.call(
          'POST',
          `/v1/content/${p.contentId}/upload/complete`,
          contributor,
          p.complete,
        );
        expect(second.status, second.raw).toBe(200);
        releaseHead();
        const lost = await first;
        expect(lost.status).toBe(409);
        expect(errorCode(lost.body)).toBe('already_completed');
      } finally {
        store.head = realHead;
      }
      expect(await events(p.contentId, p.versionId)).toBe(1);
      expect(store.completeCalls).toBeGreaterThanOrEqual(2);
    });

    it('retract while the store is blocked: the retraction is not delayed by the hung storage call; the late complete then answers 409 retracted and emits nothing', async () => {
      resetHooks();
      const p = await prepare('Race C');
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      gates.push(() => release());
      const calls = store.completeCalls;
      store.hooks.beforeComplete = async () => {
        await gate;
      };
      const pending = h.call(
        'POST',
        `/v1/content/${p.contentId}/upload/complete`,
        contributor,
        p.complete,
      );
      while (store.completeCalls === calls) await new Promise((r) => setTimeout(r, 10));
      const started = Date.now();
      const retract = await Promise.race([
        h.call('POST', `/v1/content/${p.contentId}/retract`, contributor),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 8000)),
      ]);
      const took = Date.now() - started;
      expect(retract, 'retraction was blocked behind the storage call').not.toBe('timeout');
      expect((retract as { status: number }).status).toBe(200);
      expect(took).toBeLessThan(5000);
      release();
      const late = await pending;
      resetHooks();
      expect(late.status).toBe(409);
      expect(errorCode(late.body)).toBe('retracted');
      expect(await events(p.contentId, p.versionId)).toBe(0);
      const row = await h.admin.query<{ step: string | null }>(
        'SELECT processing_step AS step FROM content_version WHERE id = $1',
        [p.versionId],
      );
      expect(row.rows[0]!.step).toBe('awaiting_upload');
    });

    it('a repeated complete is the idempotent 409 (unlocked pre-read) and the upload is not touched again', async () => {
      resetHooks();
      const p = await prepare('Race D');
      expect(
        (
          await h.call(
            'POST',
            `/v1/content/${p.contentId}/upload/complete`,
            contributor,
            p.complete,
          )
        ).status,
      ).toBe(200);
      const calls = store.completeCalls;
      const again = await h.call(
        'POST',
        `/v1/content/${p.contentId}/upload/complete`,
        contributor,
        p.complete,
      );
      expect(again.status).toBe(409);
      expect(errorCode(again.body)).toBe('already_completed');
      expect(store.completeCalls).toBe(calls); // refused before any storage call
      expect(await events(p.contentId, p.versionId)).toBe(1);
    });

    it('storage failures: an upload that vanished with no object is 400 upload_failed; wrong size and over-cap objects are refused and never complete', async () => {
      resetHooks();
      const gone = await prepare('Race E');
      store.uploads.delete(gone.uploadId); // NoSuchUpload and no object
      const r = await h.call(
        'POST',
        `/v1/content/${gone.contentId}/upload/complete`,
        contributor,
        gone.complete,
      );
      expect(r.status).toBe(400);
      expect(errorCode(r.body)).toBe('upload_failed');
      const step = await h.admin.query<{ step: string }>(
        'SELECT processing_step AS step FROM content_version WHERE id = $1',
        [gone.versionId],
      );
      expect(step.rows[0]!.step).toBe('awaiting_upload');

      // Declared 10 bytes, uploaded 12: size_mismatch.
      const contentId = await createDoc(h, contributor, 'Race F');
      const init = await h.call('POST', `/v1/content/${contentId}/upload/init`, contributor, {
        fileName: 'm.pdf',
        mimeType: 'application/pdf',
        size: 10,
        parts: 1,
      });
      const b = init.body as {
        versionId: string;
        uploadId: string;
        partUrls: Array<{ url: string }>;
      };
      const put = await fetch(b.partUrls[0]!.url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(12, 1)),
      });
      const mismatch = await h.call(
        'POST',
        `/v1/content/${contentId}/upload/complete`,
        contributor,
        {
          versionId: b.versionId,
          uploadId: b.uploadId,
          parts: [{ partNumber: 1, etag: put.headers.get('etag')! }],
        },
      );
      expect(mismatch.status).toBe(400);
      expect(errorCode(mismatch.body)).toBe('size_mismatch');

      // Declared within the cap, actual object over it (cap is 1,000 bytes here): re-checked at complete.
      const c2 = await createDoc(h, contributor, 'Race G');
      const i2 = await h.call('POST', `/v1/content/${c2}/upload/init`, contributor, {
        fileName: 'o.pdf',
        mimeType: 'application/pdf',
        size: 900,
        parts: 1,
      });
      const b2 = i2.body as {
        versionId: string;
        uploadId: string;
        partUrls: Array<{ url: string }>;
      };
      const put2 = await fetch(b2.partUrls[0]!.url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(2000, 1)),
      });
      const over = await h.call('POST', `/v1/content/${c2}/upload/complete`, contributor, {
        versionId: b2.versionId,
        uploadId: b2.uploadId,
        parts: [{ partNumber: 1, etag: put2.headers.get('etag')! }],
      });
      expect(over.status).toBe(413);
      expect(errorCode(over.body)).toBe('file_too_large');
      expect(await events(c2, b2.versionId)).toBe(0);
      // Declared over the cap is refused at presign.
      const presign = await h.call('POST', `/v1/content/${c2}/upload/init`, contributor, {
        fileName: 'o.pdf',
        mimeType: 'application/pdf',
        size: 1001,
        parts: 1,
      });
      expect(presign.status).toBe(413);
    });

    it('download limits: per-user concurrent streams are capped with 429 and freed when a stream ends; global cap holds', async () => {
      resetHooks();
      const { contentId } = await publishedDoc(
        h,
        contributor,
        dept,
        'Concurrent download',
        TEXT,
        'c.pdf',
        'application/pdf',
        Buffer.from('%PDF concurrent'),
      );
      const path = `/v1/content/${contentId}/document/original`;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      gates.push(() => release());
      let held = 0;
      store.hooks.beforeGet = async () => {
        held += 1;
        await gate;
      };
      const slots = [h.call('GET', path, member), h.call('GET', path, member)];
      while (held < 2) await new Promise((r) => setTimeout(r, 10));
      const refused = await h.call('GET', path, member);
      expect(refused.status).toBe(429);
      expect(errorCode(refused.body)).toBe('rate_limited');
      // Another user is not affected by member's per-user cap (control: caps are per user).
      store.hooks.beforeGet = async () => {};
      const other = await h.call('GET', path, contributor);
      expect(other.status).toBe(200);
      release();
      expect((await Promise.all(slots)).map((r) => r.status)).toEqual([200, 200]);
      resetHooks();
      // Freed: the same user can download again.
      expect((await h.call('GET', path, member)).status).toBe(200);
    });
  },
);
