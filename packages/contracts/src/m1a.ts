// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
// M1a API contract: auth, orgs, streams, content, upload, feed, media, notifications, sync.
// These schemas are the frozen boundary between the API, the worker, the web app and the mobile app.
import { z } from 'zod';

export const Uuid = z.uuid();
export const Email = z.email().max(254);
export const Slug = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

// ---- auth ----
export const SignupRequest = z.object({
  email: Email,
  password: z.string().min(12).max(256),
  displayName: z.string().min(1).max(120),
  orgName: z.string().min(2).max(120),
  orgSlug: Slug,
});
export const LoginRequest = z.object({ email: Email, password: z.string().min(1).max(256) });
export const MagicLinkRequest = z.object({ email: Email });
export const MagicLinkConsumeRequest = z.object({ token: z.string().min(20).max(200) });
export const Membership = z.object({
  orgId: Uuid,
  slug: Slug,
  name: z.string(),
  role: z.enum(['owner', 'admin', 'announcer', 'contributor', 'member', 'auditor']),
  status: z.enum(['active', 'deactivated']),
});
export const Me = z.object({
  user: z.object({ id: Uuid, email: Email, displayName: z.string() }),
  org: z.object({ id: Uuid, slug: Slug, name: z.string(), role: Membership.shape.role }).nullable(),
  memberships: z.array(Membership),
  csrfToken: z.string(),
});
export const SwitchOrgRequest = z.object({ orgId: Uuid });

// ---- orgs, streams, groups, invites ----
export const StreamKind = z.enum(['company', 'department', 'team', 'project', 'private']);
export const StreamRole = z.enum(['viewer', 'contributor', 'moderator', 'owner']);
export const Stream = z.object({
  id: Uuid,
  kind: StreamKind,
  slug: Slug,
  name: z.string(),
  myRole: StreamRole.nullable(),
});
export const CreateStreamRequest = z.object({
  kind: StreamKind,
  slug: Slug,
  name: z.string().min(1).max(120),
});
export const GrantStreamRoleRequest = z.object({
  role: StreamRole,
  subject: z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), userId: Uuid }),
    z.object({ type: z.literal('group'), groupId: Uuid }),
    z.object({ type: z.literal('everyone') }),
  ]),
});
export const InviteRequest = z.object({
  email: Email,
  role: Membership.shape.role.exclude(['owner']).default('member'),
});
export const MemberSummary = z.object({
  userId: Uuid,
  displayName: z.string(),
  email: Email,
  role: Membership.shape.role,
  status: Membership.shape.status,
});

// ---- content ----
export const ContentKind = z.enum(['clip', 'audio']);
export const ContentState = z.enum(['draft', 'published', 'retracted']);
export const VersionStatus = z.enum([
  'uploaded',
  'processing',
  'current',
  'superseded',
  'retracted',
  'failed',
]);
export const Link = z.object({
  kind: z.enum(['intranet', 'internet', 'attachment']),
  url: z.url().max(2048),
  label: z.string().max(200),
});
export const Chapter = z.object({
  atMs: z.number().int().nonnegative(),
  title: z.string().min(1).max(200),
});
export const AudienceTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('everyone') }),
  z.object({ type: z.literal('stream'), streamId: Uuid }),
  z.object({ type: z.literal('group'), groupId: Uuid }),
  z.object({ type: z.literal('user'), userId: Uuid }),
]);
export const CreateContentRequest = z.object({
  kind: ContentKind,
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  language: z.string().min(2).max(16).default('en'),
  links: z.array(Link).max(20).default([]),
  chapters: z.array(Chapter).max(100).default([]),
});
export const UpdateContentRequest = CreateContentRequest.omit({ kind: true }).partial();
export const PublishRequest = z.object({
  audience: z.array(AudienceTarget).min(1).max(50),
  publishAt: z.iso.datetime().nullable().default(null),
  expiresAt: z.iso.datetime().nullable().default(null),
});
export const UploadInitRequest = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().regex(/^(video|audio)\/[a-z0-9.+-]+$/i),
  size: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 * 1024 * 1024),
  parts: z.number().int().min(1).max(10000),
});
export const UploadInitResponse = z.object({
  versionId: Uuid,
  uploadId: z.string(),
  key: z.string(),
  partUrls: z.array(z.object({ partNumber: z.number().int(), url: z.url() })),
});
export const UploadCompleteRequest = z.object({
  versionId: Uuid,
  uploadId: z.string(),
  parts: z.array(z.object({ partNumber: z.number().int(), etag: z.string() })).min(1),
});
export const VersionSummary = z.object({
  id: Uuid,
  status: VersionStatus,
  processingStep: z.string().nullable(),
  processingError: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  hasCaptions: z.boolean(),
});
export const ContentDetail = z.object({
  id: Uuid,
  kind: ContentKind,
  title: z.string(),
  description: z.string(),
  language: z.string(),
  links: z.array(Link),
  chapters: z.array(Chapter),
  state: ContentState,
  publishAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  retractedAt: z.iso.datetime().nullable(),
  owner: z.object({ id: Uuid, displayName: z.string() }),
  currentVersion: VersionSummary.nullable(),
  audience: z.array(AudienceTarget),
  canEdit: z.boolean(),
  contentEpoch: z.number().int(),
});

// ---- feed ----
export const FeedItem = z.object({
  id: Uuid,
  kind: ContentKind,
  title: z.string(),
  description: z.string(),
  language: z.string(),
  links: z.array(Link),
  chapters: z.array(Chapter),
  publishAt: z.iso.datetime(),
  owner: z.object({ id: Uuid, displayName: z.string() }),
  versionId: Uuid,
  durationMs: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Relative media URLs served by the authenticated proxy; never storage URLs. */
  media: z.object({
    hls: z.string(),
    poster: z.string().nullable(),
    sprite: z.string().nullable(),
    spriteVtt: z.string().nullable(),
    captions: z.array(z.object({ lang: z.string(), url: z.string() })),
  }),
  streams: z.array(z.object({ id: Uuid, name: z.string(), kind: StreamKind })),
  viewed: z.boolean(),
  contentEpoch: z.number().int(),
});
export const FeedQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  streamId: Uuid.optional(),
});
export const FeedResponse = z.object({
  items: z.array(FeedItem),
  nextCursor: z.string().nullable(),
  authzEpoch: z.number().int(),
  orgContentEpoch: z.number().int(),
});
export const ViewEventRequest = z.object({
  versionId: Uuid,
  completed: z.boolean().default(false),
});

// ---- notifications ----
export const Notification = z.object({
  id: Uuid,
  kind: z.string(),
  reason: z.string(),
  contentId: Uuid.nullable(),
  /** Present only when the recipient can currently view the content, or (title snapshot) when the org opts in. */
  title: z.string().nullable(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export const NotificationList = z.object({
  items: z.array(Notification),
  unread: z.number().int(),
});

export const Ok = z.object({ ok: z.literal(true) });
