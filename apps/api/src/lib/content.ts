// SPDX-License-Identifier: AGPL-3.0-only
// ContentDetail assembly. Authors see everything (authorAccessible); readers see the item only when it
// is readerVisible, and then without its audience list (private principals stay hidden, ADR-0002).
import { authorAccessibleSql, readerVisibleSql } from '@our-stream/authz';
import type { TenantClient } from '@our-stream/db';
import type { z } from 'zod';
import type { AudienceTarget, ContentDetailM1b } from '@our-stream/contracts';
import { formatOfName } from './documents.js';
import { notFound } from './errors.js';
import { feedMedia } from './media.js';
import {
  commentCountSql,
  commentsEnabledSql,
  likeCountSql,
  likedSql,
  pinnedSql,
} from './m1b-sql.js';

type Detail = z.infer<typeof ContentDetailM1b>;
type Target = z.infer<typeof AudienceTarget>;

interface Row {
  id: string;
  kind: 'clip' | 'audio' | 'document';
  title: string;
  description: string;
  language: string;
  links: unknown;
  chapters: unknown;
  state: 'draft' | 'published' | 'retracted';
  publish_at: Date | null;
  expires_at: Date | null;
  retracted_at: Date | null;
  owner_id: string;
  owner_name: string | null;
  content_epoch: string;
  current_version_id: string | null;
  media_key_id: string;
  v_id: string | null;
  v_status: 'uploaded' | 'processing' | 'current' | 'superseded' | 'retracted' | 'failed';
  processing_step: string | null;
  processing_error: string | null;
  original_name: string | null;
  original_size: string | null;
  mime_type: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  assets: unknown;
  can_edit: boolean;
  visible: boolean;
  tags: Detail['tags'];
  pinned: boolean;
  like_count: number;
  liked: boolean;
  comment_count: number;
  comments_enabled: boolean;
}

interface DbChapter {
  at_ms: number;
  title: string;
}

export function chaptersToDb(chapters: Array<{ atMs: number; title: string }>): DbChapter[] {
  return chapters.map((c) => ({ at_ms: c.atMs, title: c.title }));
}

function chaptersFromDb(raw: unknown): Detail['chapters'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is DbChapter => typeof c === 'object' && c !== null && 'title' in c)
    .map((c) => ({ atMs: Number(c.at_ms ?? 0), title: String(c.title) }));
}

function linksFromDb(raw: unknown): Detail['links'] {
  return Array.isArray(raw) ? (raw as Detail['links']) : [];
}

export function audienceToTargets(
  rows: Array<{ kind: 'org' | 'user' | 'group' | 'stream'; principal_id: string }>,
): Target[] {
  return rows.map((a) => {
    switch (a.kind) {
      case 'org':
        return { type: 'everyone' as const };
      case 'stream':
        return { type: 'stream' as const, streamId: a.principal_id };
      case 'group':
        return { type: 'group' as const, groupId: a.principal_id };
      default:
        return { type: 'user' as const, userId: a.principal_id };
    }
  });
}

export function hasCaptions(assets: unknown): boolean {
  const a = assets as { captions?: Record<string, string> } | null;
  return !!a?.captions && Object.keys(a.captions).length > 0;
}

export interface LoadedContent {
  detail: Detail;
  mediaKeyId: string;
  currentVersionId: string | null;
  visible: boolean;
}

/** Loads one content item for the tenant user; throws 404 unless author-accessible or reader-visible. */
export async function loadContent(client: TenantClient, contentId: string): Promise<LoadedContent> {
  const { orgId, userId } = client.tenant;
  const r = await client.query<Row>(
    `SELECT c.id, c.kind, c.title, c.description, c.language, c.links, c.chapters, c.state, c.publish_at, c.expires_at,
            c.retracted_at, c.owner_id, c.content_epoch::text, c.current_version_id, c.media_key_id,
            a.display_name AS owner_name,
            v.id AS v_id, v.status AS v_status, v.processing_step, v.processing_error, v.original_name, v.original_size::text, v.mime_type, v.duration_ms, v.width, v.height, v.assets,
            ${authorAccessibleSql({ org: '$1', user: '$2' })} AS can_edit,
            ${readerVisibleSql({ org: '$1', user: '$2' })} AS visible,
            c.event_tags AS tags, ${pinnedSql('c', '$2')} AS pinned, ${likeCountSql('c')} AS like_count,
            ${likedSql('c', '$2')} AS liked, ${commentCountSql('c')} AS comment_count, ${commentsEnabledSql('c')} AS comments_enabled
     FROM content c
     LEFT JOIN LATERAL platform_account_get(c.owner_id) a ON true
     LEFT JOIN LATERAL (
       SELECT v.* FROM content_version v WHERE v.org_id = c.org_id AND v.content_id = c.id
       ORDER BY (v.id = c.current_version_id) DESC, v.created_at DESC LIMIT 1) v ON true
     WHERE c.org_id = $1 AND c.id = $3`,
    [orgId, userId, contentId],
  );
  const row = r.rows[0];
  if (!row || (!row.can_edit && !row.visible))
    throw notFound('content_not_found', 'content not found');
  const audience = row.can_edit
    ? audienceToTargets(
        (
          await client.query<{ kind: 'org' | 'user' | 'group' | 'stream'; principal_id: string }>(
            'SELECT kind, principal_id FROM content_audience WHERE org_id = $1 AND content_id = $2 ORDER BY kind, principal_id',
            [orgId, contentId],
          )
        ).rows,
      )
    : [];
  const showVersion = row.v_id !== null && (row.can_edit || row.v_id === row.current_version_id);
  const docFormat = row.kind === 'document' ? formatOfName(row.original_name ?? '') : null;
  const detail: Detail = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    language: row.language,
    links: linksFromDb(row.links),
    chapters: chaptersFromDb(row.chapters),
    state: row.state,
    publishAt: row.publish_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    retractedAt: row.retracted_at?.toISOString() ?? null,
    owner: { id: row.owner_id, displayName: row.owner_name ?? 'unknown' },
    currentVersion: showVersion
      ? {
          id: row.v_id!,
          status: row.v_status,
          processingStep: row.processing_step,
          processingError: row.can_edit ? row.processing_error : null,
          durationMs: row.duration_ms,
          width: row.width,
          height: row.height,
          hasCaptions: hasCaptions(row.assets),
        }
      : null,
    ...(showVersion && docFormat
      ? {
          document: {
            format: docFormat,
            fileName: row.original_name!,
            mimeType: row.mime_type ?? '',
            size: Number(row.original_size ?? 0),
            scanStatus: 'not_run' as const,
          },
        }
      : {}),
    audience,
    canEdit: row.can_edit,
    contentEpoch: Number(row.content_epoch),
    tags: row.tags,
    pinned: row.pinned,
    likeCount: row.like_count,
    liked: row.liked,
    commentCount: row.comment_count,
    commentsEnabled: row.comments_enabled,
    // Only the current, processed version is playable; same builder as the feed (relative proxy paths).
    media:
      row.v_id !== null && row.v_id === row.current_version_id && row.v_status === 'current'
        ? feedMedia(orgId, row.id, row.v_id, row.assets)
        : null,
  };
  return {
    detail,
    mediaKeyId: row.media_key_id,
    currentVersionId: row.current_version_id,
    visible: row.visible,
  };
}

/** Author gate for mutating routes: 404 when the item is not author-accessible (no existence oracle). */
export async function requireAuthor(
  client: TenantClient,
  contentId: string,
): Promise<LoadedContent> {
  const loaded = await loadContent(client, contentId);
  if (!loaded.detail.canEdit) throw notFound('content_not_found', 'content not found');
  return loaded;
}
