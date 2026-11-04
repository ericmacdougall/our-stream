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
  ContentDetail,
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
import { badRequest, conflict, fromAuthzError, fromDbError, notFound } from '../lib/errors.js';
import { originalKey } from '../lib/storage.js';
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
        response: { 200: ContentDetail },
        security,
      },
    },
    async (req) => {
      const auth = requireRole(req, PUBLISHER_ROLES);
      const b = req.body;
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
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
    { schema: { tags: ['content'], params: Params, response: { 200: ContentDetail }, security } },
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
        response: { 200: ContentDetail },
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
      const versionId = randomUUID();
      const key = originalKey(auth.orgId, contentId, versionId, randomUUID());
      await client.query(
        `INSERT INTO content_version (org_id, id, content_id, status, original_key, original_name, original_size, mime_type, processing_step)
         VALUES ($1, $2, $3, 'uploaded', $4, $5, $6, $7, 'awaiting_upload')`,
        [auth.orgId, versionId, contentId, key, body.fileName, body.size, body.mimeType],
      );
      const uploadId = await ctx.store.createMultipartUpload(key, body.mimeType);
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

  app.post(
    '/v1/content/:id/upload/complete',
    {
      schema: {
        tags: ['content'],
        params: Params,
        body: UploadCompleteRequest,
        response: { 200: Ok },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      await withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
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
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/v1/content/:id/publish',
    {
      schema: {
        tags: ['content'],
        params: Params,
        body: PublishRequest,
        response: { 200: ContentDetail },
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
    { schema: { tags: ['content'], params: Params, response: { 200: ContentDetail }, security } },
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
    }>(
      `SELECT c.current_version_id, c.media_key_id, v.status AS v_status FROM content c
       LEFT JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id
       WHERE c.org_id = $1 AND c.id = $3 AND ${readerVisibleSql({ org: '$1', user: '$2' })}`,
      [client.tenant.orgId, client.tenant.userId, contentId],
    );
    const row = r.rows[0];
    if (!row || !row.current_version_id || row.v_status !== 'current')
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
