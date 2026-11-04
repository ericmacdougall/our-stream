// SPDX-License-Identifier: AGPL-3.0-only
// The one place the web app touches the M1b routes (packages/contracts/src/m1b-paths.ts). Components
// call these functions, never openapi-fetch directly, so a contract change is an edit here. Every
// call answers a Result: `ok` with the parsed body, or a failure carrying the error code, the status,
// human-safe copy and whether the outcome is unknown (`lost`: no response, empty body or 5xx), which
// callers use for identical retries instead of resubmitting edited payloads.
import type { z } from 'zod';
import type {
  Comment,
  CommentList,
  ContentDetailM1b,
  ContentStats,
  EngagementType,
  EventTag,
  MePreferences,
  OrgSettings,
  ReactionResponse,
  SearchResponse,
  ShareResponse,
  StreamM1b,
  UpdateOrgSettingsRequest,
} from '@our-stream/contracts';
import { browserApi, errorCode } from '@/lib/api/client';
import { describeError } from '@/lib/errors';
import { t } from '@/lib/i18n';

export type Result<T> =
  | { ok: true; data: T; status: number }
  | {
      ok: false;
      code: string | undefined;
      status: number | undefined;
      message: string;
      lost: boolean;
    };

interface RawResult<T> {
  data?: T;
  error?: unknown;
  response?: Response | { status: number };
}

async function call<T>(run: () => Promise<RawResult<T>>): Promise<Result<T>> {
  let result: RawResult<T>;
  try {
    result = await run();
  } catch {
    return {
      ok: false,
      code: undefined,
      status: undefined,
      message: t('error.network'),
      lost: true,
    };
  }
  const status = result.response?.status;
  if (status !== undefined && status >= 200 && status < 300 && result.error === undefined) {
    return { ok: true, data: result.data as T, status };
  }
  const raw = result.error === undefined ? 'unknown' : errorCode(result.error);
  const code = raw === 'unknown' ? undefined : raw;
  const lost = status === undefined || status >= 500 || (code === undefined && status < 400);
  return { ok: false, code, status, message: describeError(code, status), lost };
}

export type Tag = z.output<typeof EventTag>;
export type Reaction = z.output<typeof ReactionResponse>;
export type CommentThread = z.output<typeof Comment>;
export type Comments = z.output<typeof CommentList>;
export type Search = z.output<typeof SearchResponse>;
export type Stats = z.output<typeof ContentStats>;
export type Detail = z.output<typeof ContentDetailM1b>;
export type Org = z.output<typeof OrgSettings>;
export type Preferences = z.output<typeof MePreferences>;
export type Milestone = z.output<typeof EngagementType>;

const path = (id: string) => ({ params: { path: { id } } });

// ---- reactions ----
export function setLike(contentId: string, liked: boolean): Promise<Result<Reaction>> {
  return call(() =>
    liked
      ? browserApi().POST('/v1/content/{id}/like', path(contentId))
      : browserApi().DELETE('/v1/content/{id}/like', path(contentId)),
  );
}

// ---- comments ----
export const COMMENT_PAGE = 50;

export function listComments(contentId: string, cursor?: string): Promise<Result<Comments>> {
  const query: { limit: number; cursor?: string } = { limit: COMMENT_PAGE };
  if (cursor) query.cursor = cursor;
  return call(() =>
    browserApi().GET('/v1/content/{id}/comments', {
      params: { path: { id: contentId }, query },
    }),
  );
}

export function createComment(
  contentId: string,
  input: { body: string; parentId: string | null; clientKey: string },
): Promise<Result<CommentThread>> {
  return call(() =>
    browserApi().POST('/v1/content/{id}/comments', {
      params: { path: { id: contentId } },
      body: { body: input.body, parentId: input.parentId, clientKey: input.clientKey },
    }),
  );
}

export function reportComment(commentId: string, reason = ''): Promise<Result<{ ok: true }>> {
  return call(() =>
    browserApi().POST('/v1/comments/{id}/report', {
      params: { path: { id: commentId } },
      body: { reason },
    }),
  );
}

export function removeComment(commentId: string, reason = ''): Promise<Result<CommentThread>> {
  return call(() =>
    browserApi().POST('/v1/comments/{id}/remove', {
      params: { path: { id: commentId } },
      body: { reason },
    }),
  );
}

// ---- share as link ----
export function shareWith(
  contentId: string,
  userId: string,
): Promise<Result<z.output<typeof ShareResponse>>> {
  return call(() =>
    browserApi().POST('/v1/content/{id}/share', {
      params: { path: { id: contentId } },
      body: { userId },
    }),
  );
}

/** Only a relative, single-slash path is ever prefixed with this origin. */
export function shareUrl(origin: string, linkPath: string): string | null {
  if (!/^\/(?![/\\])[^\s\\]*$/.test(linkPath)) return null;
  return `${origin.replace(/\/$/, '')}${linkPath}`;
}

// ---- search ----
export const SEARCH_PAGE = 20;

export function search(input: {
  q: string;
  cursor?: string;
  streamId?: string;
  tag?: Tag;
}): Promise<Result<Search>> {
  const query: { q: string; limit: number; cursor?: string; streamId?: string; tag?: string } = {
    q: input.q,
    limit: SEARCH_PAGE,
  };
  if (input.cursor) query.cursor = input.cursor;
  if (input.streamId) query.streamId = input.streamId;
  if (input.tag) query.tag = input.tag;
  return call(() => browserApi().GET('/v1/search', { params: { query } }));
}

// ---- engagement and stats ----
export function sendEngagement(
  contentId: string,
  event: { versionId: string; sessionKey: string; type: Milestone; positionMs: number },
): Promise<Result<{ recorded: boolean }>> {
  return call(() =>
    browserApi().POST('/v1/content/{id}/engagement', {
      params: { path: { id: contentId } },
      body: event,
    }),
  );
}

export function contentStats(contentId: string): Promise<Result<Stats>> {
  return call(() => browserApi().GET('/v1/content/{id}/stats', path(contentId)));
}

// ---- tags and pins ----
export function setTags(contentId: string, tags: Tag[]): Promise<Result<Detail>> {
  return call(() =>
    browserApi().PUT('/v1/content/{id}/tags', {
      params: { path: { id: contentId } },
      body: { tags },
    }),
  );
}

export function pin(contentId: string, streamId: string | null): Promise<Result<Detail>> {
  return call(() =>
    browserApi().POST('/v1/content/{id}/pin', {
      params: { path: { id: contentId } },
      body: { streamId },
    }),
  );
}

export function unpin(contentId: string, streamId: string | null): Promise<Result<Detail>> {
  const query: { streamId?: string } = {};
  if (streamId) query.streamId = streamId;
  return call(() =>
    browserApi().DELETE('/v1/content/{id}/pin', { params: { path: { id: contentId }, query } }),
  );
}

// ---- settings and preferences ----
export function orgSettings(): Promise<Result<Org>> {
  return call(() => browserApi().GET('/v1/org/settings'));
}

export function updateOrgSettings(
  patch: z.input<typeof UpdateOrgSettingsRequest>,
): Promise<Result<Org>> {
  return call(() => browserApi().PATCH('/v1/org/settings', { body: patch }));
}

export function updateStreamComments(
  streamId: string,
  commentsEnabled: boolean,
): Promise<Result<z.output<typeof StreamM1b>>> {
  return call(() =>
    browserApi().PATCH('/v1/streams/{id}', {
      params: { path: { id: streamId } },
      body: { commentsEnabled },
    }),
  );
}

export function preferences(): Promise<Result<Preferences>> {
  return call(() => browserApi().GET('/v1/me/preferences'));
}

export function updatePreferences(patch: Partial<Preferences>): Promise<Result<Preferences>> {
  return call(() => browserApi().PATCH('/v1/me/preferences', { body: patch }));
}

// ---- additive fields on M1a shapes (absent on an M1a-only server) ----
export interface M1bItemFields {
  tags: Tag[];
  pinned: boolean;
  likeCount: number;
  liked: boolean;
  commentCount: number;
}

/** Fills the M1b feed/detail fields so an M1a-only server (no reactions yet) still renders. */
export function withM1bDefaults<T extends object>(item: T): T & M1bItemFields {
  const raw = item as Partial<M1bItemFields>;
  return {
    ...item,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    pinned: raw.pinned === true,
    likeCount: typeof raw.likeCount === 'number' ? raw.likeCount : 0,
    liked: raw.liked === true,
    commentCount: typeof raw.commentCount === 'number' ? raw.commentCount : 0,
  };
}

/** Client key for idempotent writes (comments): opaque, 1..64 chars. */
export function mintClientKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function hasPassword(me: object | null | undefined): boolean | null {
  if (!me || !('hasPassword' in me)) return null;
  const v = (me as { hasPassword?: unknown }).hasPassword;
  return typeof v === 'boolean' ? v : null;
}

/** Media on the content detail (M1b dfae400); null before a processed version or on an M1a server. */
export function detailMedia(detail: object): Detail['media'] | null {
  if (!('media' in detail)) return null;
  const media = (detail as { media?: unknown }).media;
  return media && typeof media === 'object' && 'hls' in media ? (media as Detail['media']) : null;
}
