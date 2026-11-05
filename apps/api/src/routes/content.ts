// SPDX-License-Identifier: AGPL-3.0-only
// Content lifecycle: create, edit, upload (multipart to object storage), publish, retract, replace,
// view recording and media tokens. Audience changes go through writeTuple/deleteTuple only; state
// transitions go through the content_publish/content_retract definer functions, which have no actor
// check of their own, so every mutating route gates on authorAccessible first.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { deleteTuple, readerVisibleSql, writeTuple, type Tuple } from '@our-stream/authz';
import {
  ContentDetailM1b,
  CreateContentRequest,
  MediaTokenResponse,
  Ok,
  PublishRequest,
  UpdateContentRequest,
  UploadCompleteRequest,
  UploadInitRequest,
  UploadInitResponse,
  Uuid,
  ViewEventRequest,
} from '@our-stream/contracts';
import { withTenant, type TenantClient } from '@our-stream/db';
import type { AppContext } from '../context.js';
import { PUBLISHER_ROLES, requireMember, requireRole } from '../lib/auth.js';
import { chaptersToDb, loadContent, requireAuthor } from '../lib/content.js';
import { checkDocumentUpload, requireDocumentsEnabled } from '../lib/documents.js';
import {
  ApiError,
  badRequest,
  conflict,
  fromAuthzError,
  fromDbError,
  notFound,
} from '../lib/errors.js';
import { originalKey, type ObjectHead } from '../lib/storage.js';
import { signMediaToken } from '../lib/tokens.js';

const security = [{ cookieAuth: [] }, { bearerAuth: [] }];
const Params = z.object({ id: Uuid });

type Target = z.infer<typeof PublishRequest>['audience'][number];

function targetTuple(orgId: string, contentId: string, t: Target): Tuple {
  switch (t.type) {
    case 'everyone':
      return {
        objectType: 'content',
        objectId: contentId,
        relation: 'viewer',
        subjectType: 'org',
        subjectId: orgId,
        subjectRelation: 'member',
      };
    case 'stream':
      return {
        objectType: 'content',
        objectId: contentId,
        relation: 'viewer',
        subjectType: 'stream',
        subjectId: t.streamId,
        subjectRelation: 'viewer',
      };
    case 'group':
      return {
        objectType: 'content',
        objectId: contentId,
        relation: 'viewer',
        subjectType: 'group',
        subjectId: t.groupId,
        subjectRelation: '',
      };
    case 'user':
      return {
        objectType: 'content',
        objectId: contentId,
        relation: 'viewer',
        subjectType: 'user',
        subjectId: t.userId,
        subjectRelation: '',
      };
  }
}

const tupleKey = (t: Pick<Tuple, 'subjectType' | 'subjectId' | 'subjectRelation'>) =>
  `${t.subjectType}:${t.subjectId}:${t.subjectRelation}`;

async function emit(
  client: TenantClient,
  type: string,
  contentId: string,
  versionId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query('SELECT platform_emit_event($1, $2, $3, $4, $5::jsonb)', [
    type,
    'content',
    contentId,
    versionId,
    JSON.stringify(payload),
  ]);
}

export function registerContentRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/v1/content',
    {
      schema: {
        tags: ['content'],
        body: CreateContentRequest,
        response: { 200: ContentDetailM1b },
        security,
      },
    },
    async (req) => {
      const auth = requireRole(req, PUBLISHER_ROLES);
      const b = req.body;
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        // A document draft can never be uploaded, listed or published while documents are off, so it is
        // refused up front (403 feature_disabled) instead of leaving an orphan draft behind.
        if (b.kind === 'document') await requireDocumentsEnabled(client);
        const r = await client.query<{ id: string }>(
          `INSERT INTO content (org_id, kind, owner_id, title, description, language, links, chapters)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb) RETURNING id`,
          [
            auth.orgId,
            b.kind,
            auth.userId,
            b.title,
            b.description,
            b.language,
            JSON.stringify(b.links),
            JSON.stringify(chaptersToDb(b.chapters)),
          ],
        );
        return (await loadContent(client, r.rows[0]!.id)).detail;
      });
    },
  );

  app.get(
    '/v1/content/:id',
    {
      schema: { tags: ['content'], params: Params, response: { 200: ContentDetailM1b }, security },
    },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const loaded = await loadContent(client, req.params.id);
        // ADR-0002: an admin (not the owner) opening a draft is an audit event.
        if (
          loaded.detail.canEdit &&
          loaded.detail.state === 'draft' &&
          loaded.detail.owner.id !== auth.userId
        ) {
          await client.query(
            `INSERT INTO audit_event (org_id, actor_id, action, target) VALUES ($1, $2, 'content.draft_opened', $3::jsonb)`,
            [auth.orgId, auth.userId, JSON.stringify({ contentId: req.params.id })],
          );
        }
        return loaded.detail;
      });
    },
  );

  app.patch(
    '/v1/content/:id',
    {
      schema: {
        tags: ['content'],
        params: Params,
        body: UpdateContentRequest,
        response: { 200: ContentDetailM1b },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      const b = req.body;
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await requireAuthor(client, req.params.id);
        // content_epoch is bumped explicitly so link/chapter edits also invalidate caches (ADR-0004).
        await client.query(
          `UPDATE content SET
             title = COALESCE($3, title), description = COALESCE($4, description), language = COALESCE($5, language),
             links = COALESCE($6::jsonb, links), chapters = COALESCE($7::jsonb, chapters),
             content_epoch = content_epoch + 1, updated_at = now()
           WHERE org_id = $1 AND id = $2`,
          [
            auth.orgId,
            req.params.id,
            b.title ?? null,
            b.description ?? null,
            b.language ?? null,
            b.links ? JSON.stringify(b.links) : null,
            b.chapters ? JSON.stringify(chaptersToDb(b.chapters)) : null,
          ],
        );
        return (await loadContent(client, req.params.id)).detail;
      });
    },
  );

  const uploadInit = async (
    auth: { orgId: string; userId: string },
    contentId: string,
    body: z.infer<typeof UploadInitRequest>,
  ): Promise<z.infer<typeof UploadInitResponse>> =>
    withTenant(ctx.pool, auth, async (client) => {
      const loaded = await requireAuthor(client, contentId);
      if (loaded.detail.state === 'retracted')
        throw conflict('retracted', 'retracted content cannot receive uploads');
      let originalName = body.fileName;
      let storedContentType = body.mimeType;
      if (loaded.detail.kind === 'document') {
        await requireDocumentsEnabled(client);
        const verdict = checkDocumentUpload(body.fileName, body.mimeType);
        if (!verdict.ok) throw badRequest(verdict.code, verdict.message);
        if (body.size > ctx.config.DOCUMENT_MAX_BYTES)
          throw new ApiError(
            413,
            'file_too_large',
            `documents are limited to ${ctx.config.DOCUMENT_MAX_BYTES} bytes`,
          );
        // Stored bytes the org already holds. A version that never finished uploading stops counting once
        // its presigned URLs have expired (an abandoned init must not hold quota forever).
        const used = await client.query<{ bytes: string }>(
          `SELECT COALESCE(sum(v.original_size), 0)::text AS bytes
           FROM content_version v JOIN content c ON c.org_id = v.org_id AND c.id = v.content_id
           WHERE v.org_id = $1 AND c.kind = 'document' AND v.status <> 'failed'
             AND NOT (v.processing_step IS NOT DISTINCT FROM 'awaiting_upload'
                      AND v.created_at < now() - make_interval(secs => $2))`,
          [auth.orgId, ctx.config.UPLOAD_URL_TTL_SECONDS],
        );
        if (Number(used.rows[0]?.bytes ?? 0) + body.size > ctx.config.DOCUMENT_ORG_QUOTA_BYTES)
          throw new ApiError(
            429,
            'quota_exceeded',
            'the organisation document storage quota is used up',
          );
        if (!ctx.limits.documentUpload.allow(auth.userId))
          throw new ApiError(429, 'rate_limited', 'too many document uploads, try again later');
        originalName = verdict.fileName;
        // Stored objects carry no meaningful type; they are only ever served by our own download route.
        storedContentType = 'application/octet-stream';
      } else if (!/^(video|audio)\//i.test(body.mimeType)) {
        throw badRequest('validation', 'mimeType must be video/* or audio/* for clips and audio');
      }
      if (body.parts > Math.ceil(body.size / (5 * 1024 * 1024)) + 1)
        throw badRequest('too_many_parts', 'part count does not match the file size');
      const versionId = randomUUID();
      const key = originalKey(auth.orgId, contentId, versionId, randomUUID());
      await client.query(
        `INSERT INTO content_version (org_id, id, content_id, status, original_key, original_name, original_size, mime_type, processing_step)
         VALUES ($1, $2, $3, 'uploaded', $4, $5, $6, $7, 'awaiting_upload')`,
        [auth.orgId, versionId, contentId, key, originalName, body.size, body.mimeType],
      );
      const uploadId = await ctx.store.createMultipartUpload(key, storedContentType);
      const partUrls = await Promise.all(
        Array.from({ length: body.parts }, (_, i) => i + 1).map(async (partNumber) => ({
          partNumber,
          url: await ctx.store.presignUploadPart(
            key,
            uploadId,
            partNumber,
            ctx.config.UPLOAD_URL_TTL_SECONDS,
          ),
        })),
      );
      return { versionId, uploadId, key, partUrls };
    });

  app.post(
    '/v1/content/:id/upload/init',
    {
      schema: {
        tags: ['content'],
        params: Params,
        body: UploadInitRequest,
        response: { 200: UploadInitResponse },
        security,
      },
    },
    async (req) => uploadInit(requireMember(req), req.params.id, req.body),
  );

  app.post(
    '/v1/content/:id/replace',
    {
      schema: {
        tags: ['content'],
        params: Params,
        body: UploadInitRequest,
        response: { 200: UploadInitResponse },
        security,
      },
    },
    async (req) => uploadInit(requireMember(req), req.params.id, req.body),
  );

  /**
   * Upload complete for a document (spec "reordered flow"). The content row lock is never held across a
   * storage call, so a hung object store cannot delay a retraction or the parse job's finish:
   *   1. unlocked pre-read: 409 unless the version is still awaiting its upload;
   *   2. complete the multipart upload and `head` the object, no lock;
   *   3. take the content lock (content first, then version, the order every document function uses),
   *      re-verify the version is still awaiting upload and the content is not retracted, then call
   *      `document_upload_complete` and emit `content.version_uploaded` once.
   * Two concurrent completes therefore produce one job; the loser gets the idempotent 409, never a storage
   * error: when its own storage call fails with NoSuchUpload it re-reads under the lock and, if the other
   * request already finished, answers 409; if the version is still awaiting it `head`s the object and a
   * matching size counts as completion by the lock holder.
   */
  const completeDocumentUpload = async (
    auth: { orgId: string; userId: string },
    contentId: string,
    body: z.infer<typeof UploadCompleteRequest>,
  ) => {
    const pre = await withTenant(ctx.pool, auth, async (client) => {
      await requireAuthor(client, contentId);
      await requireDocumentsEnabled(client);
      const v = await client.query<{
        original_key: string;
        original_size: string | null;
        processing_step: string | null;
      }>(
        `SELECT original_key, original_size::text, processing_step FROM content_version
         WHERE org_id = $1 AND id = $2 AND content_id = $3`,
        [auth.orgId, body.versionId, contentId],
      );
      const version = v.rows[0];
      if (!version) throw notFound('version_not_found', 'version not found');
      if (version.processing_step !== 'awaiting_upload')
        throw conflict('already_completed', 'this upload was already completed');
      return version;
    });
    const checkHead = (head: ObjectHead | null) => {
      if (!head) throw badRequest('upload_failed', 'uploaded object not found');
      // Re-checked against the object that is really in storage, not the size the client declared.
      if (head.size > ctx.config.DOCUMENT_MAX_BYTES)
        throw new ApiError(
          413,
          'file_too_large',
          `documents are limited to ${ctx.config.DOCUMENT_MAX_BYTES} bytes`,
        );
      if (String(head.size) !== pre.original_size)
        throw badRequest(
          'size_mismatch',
          `uploaded ${head.size} bytes, declared ${pre.original_size}`,
        );
    };
    let storageError: unknown = null;
    let head: ObjectHead | null = null;
    try {
      await ctx.store.completeMultipartUpload(pre.original_key, body.uploadId, body.parts);
      head = await ctx.store.head(pre.original_key);
    } catch (err) {
      storageError = err;
    }
    if (!storageError) checkHead(head);

    return withTenant(ctx.pool, auth, async (client) => {
      const c = await client.query<{ retracted_at: Date | null }>(
        `SELECT retracted_at FROM content WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [auth.orgId, contentId],
      );
      const v = await client.query<{ status: string; processing_step: string | null }>(
        `SELECT status, processing_step FROM content_version
         WHERE org_id = $1 AND id = $2 AND content_id = $3 FOR UPDATE`,
        [auth.orgId, body.versionId, contentId],
      );
      const version = v.rows[0];
      if (!c.rows[0] || !version) throw notFound('version_not_found', 'version not found');
      if (version.processing_step !== 'awaiting_upload')
        throw conflict('already_completed', 'this upload was already completed');
      if (c.rows[0].retracted_at !== null || version.status !== 'uploaded')
        throw conflict('retracted', 'this content or version can no longer be uploaded');
      if (storageError) {
        const name = (storageError as { name?: string }).name;
        if (name !== 'NoSuchUpload')
          throw badRequest('upload_failed', `storage rejected the upload: ${name ?? 'error'}`);
        // The other request completed the multipart upload first; the object is there if sizes agree.
        checkHead(await ctx.store.head(pre.original_key));
      }
      try {
        await client.query('SELECT document_upload_complete($1, $2)', [contentId, body.versionId]);
      } catch (err) {
        throw fromDbError(err);
      }
      await emit(client, 'content.version_uploaded', contentId, body.versionId, {});
      return (await loadContent(client, contentId)).detail;
    });
  };

  app.post(
    '/v1/content/:id/upload/complete',
    {
      schema: {
        tags: ['content'],
        params: Params,
        body: UploadCompleteRequest,
        response: { 200: ContentDetailM1b },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      const kind = await withTenant(
        ctx.pool,
        { orgId: auth.orgId, userId: auth.userId },
        async (client) => (await requireAuthor(client, req.params.id)).detail.kind,
      );
      if (kind === 'document')
        return completeDocumentUpload(
          { orgId: auth.orgId, userId: auth.userId },
          req.params.id,
          req.body,
        );
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await requireAuthor(client, req.params.id);
        const v = await client.query<{
          original_key: string;
          original_size: string | null;
          processing_step: string | null;
        }>(
          `SELECT original_key, original_size::text, processing_step FROM content_version
           WHERE org_id = $1 AND id = $2 AND content_id = $3 FOR UPDATE`,
          [auth.orgId, req.body.versionId, req.params.id],
        );
        const version = v.rows[0];
        if (!version) throw notFound('version_not_found', 'version not found');
        if (version.processing_step !== 'awaiting_upload')
          throw conflict('already_completed', 'this upload was already completed');
        try {
          await ctx.store.completeMultipartUpload(
            version.original_key,
            req.body.uploadId,
            req.body.parts,
          );
        } catch (err) {
          throw badRequest('upload_failed', `storage rejected the upload: ${(err as Error).name}`);
        }
        const head = await ctx.store.head(version.original_key);
        if (!head) throw badRequest('upload_failed', 'uploaded object not found');
        if (String(head.size) !== version.original_size)
          throw badRequest(
            'size_mismatch',
            `uploaded ${head.size} bytes, declared ${version.original_size}`,
          );
        await client.query(
          `UPDATE content_version SET processing_step = 'uploaded' WHERE org_id = $1 AND id = $2`,
          [auth.orgId, req.body.versionId],
        );
        await emit(client, 'content.version_uploaded', req.params.id, req.body.versionId, {});
        // Clients poll the detail after completion; return it so the uploaded version is in hand immediately.
        return (await loadContent(client, req.params.id)).detail;
      });
    },
  );

  app.post(
    '/v1/content/:id/publish',
    {
      schema: {
        tags: ['content'],
        params: Params,
        body: PublishRequest,
        response: { 200: ContentDetailM1b },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      const contentId = req.params.id;
      const publishAt = req.body.publishAt ? new Date(req.body.publishAt) : null;
      const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
      if (publishAt && expiresAt && expiresAt.getTime() <= publishAt.getTime())
        throw badRequest('bad_expiry', 'expiresAt must be after publishAt');
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const loaded = await requireAuthor(client, contentId);
        if (loaded.detail.state === 'retracted')
          throw conflict('retracted', 'retracted content cannot be published');
        const media = await client.query(
          `SELECT 1 FROM content_version WHERE org_id = $1 AND content_id = $2
             AND status IN ('uploaded', 'processing', 'current') AND processing_step IS DISTINCT FROM 'awaiting_upload'`,
          [auth.orgId, contentId],
        );
        if ((media.rowCount ?? 0) === 0)
          throw conflict('no_media', 'upload media before publishing');

        // Diff the audience: write new targets, delete dropped ones (writeTuple validates every rule).
        const desired = new Map<string, Tuple>();
        for (const t of req.body.audience) {
          const tuple = targetTuple(auth.orgId, contentId, t);
          desired.set(tupleKey(tuple), tuple);
        }
        const existing = await client.query<
          Pick<Tuple, 'subjectType' | 'subjectId' | 'subjectRelation'>
        >(
          `SELECT subject_type AS "subjectType", subject_id AS "subjectId", subject_relation AS "subjectRelation"
           FROM relation_tuple WHERE org_id = $1 AND object_type = 'content' AND object_id = $2 AND relation = 'viewer'`,
          [auth.orgId, contentId],
        );
        const have = new Set(existing.rows.map(tupleKey));
        try {
          for (const [key, tuple] of desired) if (!have.has(key)) await writeTuple(client, tuple);
          for (const row of existing.rows) {
            if (!desired.has(tupleKey(row)))
              await deleteTuple(client, {
                objectType: 'content',
                objectId: contentId,
                relation: 'viewer',
                ...row,
              });
          }
        } catch (err) {
          throw fromAuthzError(err);
        }
        try {
          await client.query('SELECT content_publish($1, $2, $3)', [
            contentId,
            publishAt,
            expiresAt,
          ]);
        } catch (err) {
          throw fromDbError(err);
        }
        const immediate = !publishAt || publishAt.getTime() <= Date.now();
        if (immediate) {
          await emit(client, 'content.published', contentId, loaded.currentVersionId, {});
        } else {
          await emit(client, 'content.scheduled', contentId, loaded.currentVersionId, {
            publishAt: publishAt.toISOString(),
            expiresAt: expiresAt?.toISOString() ?? null,
          });
        }
        if (expiresAt) {
          await emit(client, 'content.expiry_scheduled', contentId, loaded.currentVersionId, {
            expiresAt: expiresAt.toISOString(),
          });
        }
        return (await loadContent(client, contentId)).detail;
      });
    },
  );

  app.post(
    '/v1/content/:id/retract',
    {
      schema: { tags: ['content'], params: Params, response: { 200: ContentDetailM1b }, security },
    },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const loaded = await requireAuthor(client, req.params.id);
        try {
          await client.query('SELECT content_retract($1)', [req.params.id]);
        } catch (err) {
          throw fromDbError(err);
        }
        await emit(client, 'content.retracted', req.params.id, loaded.currentVersionId, {});
        return (await loadContent(client, req.params.id)).detail;
      });
    },
  );

  const visibleCurrent = async (
    client: TenantClient,
    contentId: string,
  ): Promise<{ versionId: string; mediaKeyId: string }> => {
    const r = await client.query<{
      current_version_id: string | null;
      media_key_id: string;
      v_status: string | null;
      kind: string;
    }>(
      `SELECT c.current_version_id, c.media_key_id, c.kind, v.status AS v_status FROM content c
       LEFT JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id
       WHERE c.org_id = $1 AND c.id = $3 AND ${readerVisibleSql({ org: '$1', user: '$2' })}`,
      [client.tenant.orgId, client.tenant.userId, contentId],
    );
    const row = r.rows[0];
    // Documents have no playable media: view recording and media tokens are for clips and audio only.
    if (!row || row.kind === 'document' || !row.current_version_id || row.v_status !== 'current')
      throw notFound('content_not_found', 'content not found');
    return { versionId: row.current_version_id, mediaKeyId: row.media_key_id };
  };

  app.post(
    '/v1/content/:id/view',
    {
      schema: {
        tags: ['content'],
        params: Params,
        body: ViewEventRequest,
        response: { 200: Ok },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      await withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const cur = await visibleCurrent(client, req.params.id);
        if (cur.versionId !== req.body.versionId)
          throw conflict('stale_version', 'that version is no longer current');
        await client.query('SELECT record_view($1, $2, $3)', [
          req.params.id,
          req.body.versionId,
          req.body.completed,
        ]);
      });
      return { ok: true as const };
    },
  );

  app.get(
    '/v1/content/:id/media-token',
    {
      schema: { tags: ['media'], params: Params, response: { 200: MediaTokenResponse }, security },
    },
    async (req) => {
      const auth = requireMember(req);
      const cur = await withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, (client) =>
        visibleCurrent(client, req.params.id),
      );
      const exp = Math.floor(Date.now() / 1000) + ctx.config.MEDIA_TOKEN_TTL_SECONDS;
      const token = signMediaToken(ctx.config.MEDIA_HMAC_SECRET, {
        userId: auth.userId,
        orgId: auth.orgId,
        versionId: cur.versionId,
        mediaKeyId: cur.mediaKeyId,
        exp,
      });
      return { token, versionId: cur.versionId, expiresAt: new Date(exp * 1000).toISOString() };
    },
  );
}
