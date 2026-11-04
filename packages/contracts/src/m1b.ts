// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
// M1b API contract: reactions, comments and moderation, share-as-link, keyword search, engagement
// events and per-clip stats under the org privacy mode, org/stream settings, event tags, pins, feed
// filters and notification preferences. Additive to the frozen M1a schemas in ./m1a.ts: every
// extended response keeps the M1a fields, so M1a clients keep working.
//
// Pagination: every list is cursor-paginated. `cursor` is opaque (base64url); `limit` is capped at 50.
// A malformed cursor answers 400 `bad_cursor`.
//
// Error codes added in M1b (ErrorResponse.error.code): `comments_disabled`, `comment_blocked`,
// `comment_not_found`, `bad_parent`, `idempotency_mismatch`, `moderation_forbidden`, `pin_forbidden`,
// `not_in_audience`, `not_published`, `self_share`, `stale_version` (reused), `bad_cursor` (reused),
// `content_not_found` (reused: invisible content is never distinguishable from missing content).
import { z } from 'zod';
import {
  ContentDetail,
  ContentKind,
  FeedItem,
  FeedQuery,
  FeedResponse,
  Me,
  Stream,
  StreamKind,
  Uuid,
} from './m1a.js';

export const EventTag = z.enum(['onboarding', 'announcement', 'current-events', 'training']);
export const Cursor = z.string().min(1).max(300);
export const PageLimit = z.coerce.number().int().min(1).max(50).default(20);
const Count = z.number().int().nonnegative();
const Iso = z.iso.datetime();

// ---- reactions ----
/** Both `POST` (like) and `DELETE` (unlike) are idempotent and answer the state after the call. */
export const ReactionResponse = z.object({ liked: z.boolean(), likeCount: Count });

// ---- comments ----
export const CommentState = z.enum(['visible', 'removed']);
/**
 * Bodies are NFC-normalised, then stripped of C0/C1 control characters (newline and tab kept), bidi
 * controls (U+202A-U+202E, U+2066-U+2069) and zero-width space/word joiner/BOM, then trimmed, before
 * the 1..2000 UTF-16 code-unit length check. The API stores and returns plain text; clients render it
 * as text, never as HTML.
 */
export const CommentBody = z.string().min(1).max(2000);
export const CreateCommentRequest = z.object({
  body: CommentBody,
  /** A root comment of the same item to reply to; replying to a reply attaches to that reply's root. Unknown, removed or other-item parents answer 404 `bad_parent`. */
  parentId: Uuid.nullable().default(null),
  /**
   * Idempotency key chosen by the client, scoped to (author, item). A replay with the same key and the
   * same body/parent returns the original comment with 200; a different body or parent answers 409
   * `idempotency_mismatch`.
   */
  clientKey: z.string().min(1).max(64).optional(),
});
export const CommentAuthor = z.object({ id: Uuid, displayName: z.string() });
const CommentCore = z.object({
  id: Uuid,
  contentId: Uuid,
  parentId: Uuid.nullable(),
  /** null once removed (tombstone keeps the thread shape, never the text or the author). */
  author: CommentAuthor.nullable(),
  body: z.string().nullable(),
  state: CommentState,
  createdAt: Iso,
  removedAt: Iso.nullable(),
  /** Present only for moderators of the content. */
  reportCount: Count.optional(),
  /** True when the caller may remove this comment (own comment, or moderator of the content). */
  canRemove: z.boolean(),
});
export const Comment = CommentCore.extend({
  /** Replies in creation order; at most `limit` per root, see `replyCount` for the total. */
  replies: z.array(CommentCore),
  replyCount: Count,
});
export const CommentListQuery = z.object({ cursor: Cursor.optional(), limit: PageLimit });
export const CommentList = z.object({
  items: z.array(Comment),
  nextCursor: z.string().nullable(),
  /** False when the org or one of the item's audience streams disabled comments; creation then answers 409 `comments_disabled`. */
  commentsEnabled: z.boolean(),
  /** True for org owners/admins and moderators/owners of a stream the item is addressed to. */
  canModerate: z.boolean(),
});
export const ReportCommentRequest = z.object({ reason: z.string().max(500).default('') });
export const RemoveCommentRequest = z.object({ reason: z.string().max(500).default('') });

// ---- share as link (ADR-0002: sharing never writes tuples) ----
export const ShareRequest = z.object({ userId: Uuid });
export const ShareResponse = z.object({
  /** False when the recipient cannot currently view the item (unknown, deactivated and no-access recipients answer identically); every attempt is audited and budgeted (`SHARE_RATE_LIMIT_MAX`). */
  delivered: z.boolean(),
  /** Relative web path for the item, e.g. `/content/{id}`; clients prefix their own origin. */
  linkPath: z.string(),
});

// ---- search (ADR-0013) ----
export const SearchQuery = z.object({
  /** Free text; `websearch_to_tsquery` syntax (quotes, `or`, `-`) is accepted and never errors. */
  q: z.string().min(1).max(200),
  cursor: Cursor.optional(),
  limit: PageLimit,
  streamId: Uuid.optional(),
  tag: EventTag.optional(),
});
export const SnippetSource = z.enum(['title', 'description', 'transcript']);
export const Snippet = z.object({
  source: SnippetSource,
  /** Plain text, never markup. */
  text: z.string(),
  /**
   * Highlight spans as `[start, end)` pairs of UTF-16 code-unit offsets into `text` (the indices
   * JavaScript, Hermes and Kotlin/Swift `String.utf16` use), ascending and non-overlapping.
   */
  ranges: z.array(z.tuple([Count, Count])),
  /** For transcript snippets: the millisecond offset to open the player at; null for title/description. */
  tMs: Count.nullable(),
});
export const SearchHit = z.object({
  id: Uuid,
  kind: ContentKind,
  title: z.string(),
  description: z.string(),
  publishAt: Iso,
  owner: z.object({ id: Uuid, displayName: z.string() }),
  versionId: Uuid,
  durationMs: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Same relative proxy URLs as `FeedItem.media`, so a hit can be played (at `tMs`) without another request. */
  media: FeedItem.shape.media,
  streams: z.array(z.object({ id: Uuid, name: z.string(), kind: StreamKind })),
  tags: z.array(EventTag),
  snippets: z.array(Snippet),
  /** `ts_rank_cd` normalised to 0..1; ties broken by `publishAt` desc. */
  score: z.number().min(0).max(1),
});
export const SearchResponse = z.object({
  items: z.array(SearchHit),
  /** Count of reader-visible matches for the whole query (not just this page), capped at 1000. */
  total: Count,
  nextCursor: z.string().nullable(),
  authzEpoch: z.number().int(),
  orgContentEpoch: z.number().int(),
});

// ---- engagement (ADR-0006) ----
export const EngagementType = z.enum([
  'view_start',
  'progress_25',
  'progress_50',
  'progress_75',
  'complete',
]);
export const EngagementEventRequest = z.object({
  versionId: Uuid,
  /** Client-generated playback session key (opaque, 1..64 chars); the idempotency key is (session, content, version, type). */
  sessionKey: z.string().min(1).max(64),
  type: EngagementType,
  positionMs: Count.optional(),
});
/**
 * `recorded` is false on a replay (same session, content, version and type) and once a user has used
 * more than 50 distinct session keys for one item in 24 h. A `view_start` from a new session after the
 * user completed (or passed 75 % of) the item is also counted as a rewatch server-side; `view_start`
 * keeps `user_content_state` (last version, title snapshot) current for retraction notices (ADR-0005).
 */
export const EngagementResponse = z.object({ recorded: z.boolean() });

/** Stored default is `identified_for_required_only` (decision Q1); until required content exists (M4) it behaves exactly like `aggregate_only`. */
export const PrivacyMode = z.enum(['aggregate_only', 'named', 'identified_for_required_only']);
export const ViewerRow = z.object({
  userId: Uuid,
  displayName: z.string(),
  firstViewedAt: Iso.nullable(),
  lastViewedAt: Iso.nullable(),
  maxProgressPct: z.number().int().min(0).max(100),
  completed: z.boolean(),
  watchCount: Count,
});
/** Author-only (authorAccessible). `viewers` is present only when the org privacy mode is `named`; `identified_for_required_only` behaves as `aggregate_only` until required content exists (M4). */
export const ContentStats = z.object({
  contentId: Uuid,
  privacyMode: PrivacyMode,
  uniqueViewers: Count,
  viewStarts: Count,
  completions: Count,
  rewatches: Count,
  milestones: z.object({ p25: Count, p50: Count, p75: Count }),
  likes: Count,
  comments: Count,
  viewers: z.array(ViewerRow).optional(),
});

// ---- org and stream settings ----
export const CommentScanPolicy = z.enum(['off', 'warn', 'block']);
export const OrgSettings = z.object({
  privacyMode: PrivacyMode,
  commentsEnabled: z.boolean(),
  /** Raw engagement events older than this are pruned (decision Q12: 13 months). */
  engagementRetentionDays: z.number().int().min(30).max(3650),
  /** ADR-0009 comment scanner: `off` (default), `warn` (findings logged), `block` (400 `comment_blocked`). */
  commentScanPolicy: CommentScanPolicy,
});
export const UpdateOrgSettingsRequest = OrgSettings.partial();
export const UpdateStreamRequest = z.object({ commentsEnabled: z.boolean().optional() });
export const StreamM1b = Stream.extend({ commentsEnabled: z.boolean() });

// ---- event tags and pins ----
export const SetTagsRequest = z.object({
  tags: z
    .array(EventTag)
    .max(4)
    .refine((t) => new Set(t).size === t.length, { message: 'tags must be unique' }),
});
/** `streamId` null pins org-wide (owner/admin/announcer); a stream pin needs moderator/owner on that stream or an org admin role, and the item must be addressed to that stream. */
export const PinRequest = z.object({ streamId: Uuid.nullable().default(null) });
export const PinQuery = z.object({ streamId: Uuid.optional() });

// ---- feed and detail extensions ----
export const FeedQueryM1b = FeedQuery.extend({
  tag: EventTag.optional(),
  /** `true` restricts the feed to items pinned org-wide or in a stream the caller can access (and in `streamId` when given). */
  pinned: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export const FeedItemM1b = FeedItem.extend({
  tags: z.array(EventTag),
  pinned: z.boolean(),
  likeCount: Count,
  liked: z.boolean(),
  commentCount: Count,
});
export const FeedResponseM1b = FeedResponse.extend({ items: z.array(FeedItemM1b) });
export const ContentDetailM1b = ContentDetail.extend({
  tags: z.array(EventTag),
  pinned: z.boolean(),
  likeCount: Count,
  liked: z.boolean(),
  commentCount: Count,
  commentsEnabled: z.boolean(),
});

// ---- account ----
/** `hasPassword` lets the account page hide the set-password form for password accounts (web owner request). */
export const MeM1b = Me.extend({ hasPassword: z.boolean() });
export const AuthResponseM1b = MeM1b.extend({ sessionToken: z.string().optional() });

// ---- notification preferences ----
export const MePreferences = z.object({ emailDigest: z.enum(['daily', 'off']) });
export const UpdateMePreferencesRequest = MePreferences.partial();
