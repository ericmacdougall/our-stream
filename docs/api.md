# API: sessions, CSRF, uploads, publishing, feed, media (M1a); reactions, comments, search, engagement, pins (M1b)

The API in `apps/api` is the single authorization surface (ADR-0011). Every route is declared with the
Zod schemas in `packages/contracts/src/m1a.ts` and `m1b.ts`, so `pnpm contracts:generate` regenerates the typed
client from the live OpenAPI document (`GET /openapi.json`). This page documents the behaviour that is
not visible in the schemas.

## Sessions

- `POST /v1/auth/signup`, `POST /v1/auth/login` and `POST /v1/auth/magic-link/consume` create a session:
  a random 32-byte token whose SHA-256 is stored (`platform_session_create`); the token itself is only
  ever in the `os_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` unless `NODE_ENV=development`,
  `Path=/`, `SESSION_TTL_DAYS`).
- Native clients that cannot use cookies send `x-session-transport: bearer` on those three calls and
  receive `sessionToken` in the body (`AuthResponse`); afterwards they send `Authorization: Bearer <token>`.
  Web clients never see the token.
- On every request the API hashes the presented token, looks the session up (`platform_session_lookup`)
  and reads the membership row for the session's org (role, status, `authz_epoch`) inside `withTenant`.
  Nothing about permissions is carried in the cookie (ADR-0002, ADR-0004). A deactivated member is
  refused on the next request: the membership trigger revokes the org's sessions (401), and a surviving
  session still fails the active-membership check (403 `not_member`).
- `POST /v1/auth/logout` revokes the session; `POST /v1/me/org` switches the session's org
  (`platform_session_switch_org`, active membership required).
- Passwords are hashed with argon2id (m = 19 MiB, t = 2, p = 1); an unknown email costs the same
  verification time as a wrong password.

## CSRF

Cookie-authenticated mutations (anything but GET/HEAD/OPTIONS with a session cookie) must carry one of:

1. `x-csrf-token: <csrfToken>` where `csrfToken` comes from `GET /v1/me` (an HMAC of the session id with
   `SESSION_SECRET`; derived, never stored), or
2. an `Origin` header equal to `APP_BASE_URL`'s origin or to the API's own host (same-origin
   deployments), or `Sec-Fetch-Site: same-origin` when the browser omits `Origin`.

Otherwise the request is refused with 403 `csrf`. Bearer requests carry no ambient credential and are
exempt. Sign-in routes have no session yet and are instead rate limited per client address
(`AUTH_RATE_LIMIT_MAX` per minute) and per normalised email (`AUTH_EMAIL_RATE_LIMIT_MAX`); authenticated
requests are budgeted by the validated session id, requests without a session by address. All answer
429 `rate_limited`. See "Proxies and rate limits" in `development.md` for what `TRUST_PROXY` must be
for the address budgets to mean anything.

Signing up with an address that already has an account, including a password-less account created by
an invite, answers 409 `email_taken`: an unauthenticated request never claims an existing account.
An invited user signs in through the emailed link and may then choose a password once with
`POST /v1/auth/password` (`{password}`; 409 `password_set` when one exists). Client note: the web app
offers this on `/account`; `Me` carries `hasPassword` (M1b), so the form is hidden when it is true and
shown otherwise (an M1a server has no flag), and the 409 is presented as a settled outcome. There is no reset endpoint, so a client must never let
a person believe a different password was stored than the one the server kept: after a lost response
the web app resends the identical value or abandons it with a warning.

Client notes (web, M1b): the web app reaches every M1b route through `apps/web/src/lib/m1b/api.ts`;
search queries travel only in the `/search` page URL (plain GET form) and are never logged by the
client; a transcript hit's `tMs` becomes `/search?q=…&play={id}&t={ms}` (inline player) and
`/content/{id}?t={ms}` (detail player, once `ContentDetailM1b.media` is present); engagement events
are sent with a client session key per playback session and retried with the same key, so a replayed
request is deduplicated server-side (`recorded: false`).

## Magic links and invites

- `POST /v1/auth/magic-link` always answers `{ok: true}`; a link is sent only when the address has an
  account. Links are single use and expire after `MAGIC_LINK_TTL_MINUTES` (`platform_magic_link_consume`
  consumes atomically). The link is `${APP_BASE_URL}/auth/magic?token=...`; the web app posts the token
  to `POST /v1/auth/magic-link/consume`.
- `POST /v1/invites` (org owner/admin) creates an account for the address if needed (no password), upserts
  the `invite` row and sends a link with purpose `invite`. Consuming it calls `platform_invite_accept`,
  which creates the membership, and the new session is bound to that org. A failed acceptance rolls the
  consumption back so the link can be retried after a new invite.
- Mail goes through the SMTP adapter (`SMTP_URL`, nodemailer). Without `SMTP_URL` messages are logged as
  skipped (never with the link) and password sign-in keeps working.

## Streams, grants and members

- `POST /v1/streams` is an owner/admin action in M1a; the creator receives the `owner` stream role through
  `writeTuple`. (Members creating personal private streams needs a bootstrap rule in `writeTuple` and is
  deferred.) Private streams are listed only to members holding a role on them.
- `POST /v1/streams/:id/grants` writes one tuple through `writeTuple`; rule violations map to 403 with the
  rule code (`stream_owner_required`, `bad_subject`, ...), missing streams/groups to 404.
- `GET /v1/streams`, `GET /v1/members` and `GET /v1/streams/:id/members` answer `{ items: [...] }` as the
  frozen contract declares (the M1a routes answered bare arrays, GoodQA #35633). Stream members are the
  effective members from `user_stream_access` (highest role, including access through groups and the
  everyone grant) who are active; a private stream's members are listable only by members holding a role
  on it (404 `stream_not_found` otherwise), like the stream list.

## Content lifecycle

- `POST /v1/content` (owner, admin, announcer, contributor) creates a draft owned by the caller.
  Chapters are stored as `{at_ms, title}` and exposed as `{atMs, title}`.
- `GET /v1/content/:id` answers for authors (`authorAccessible`, `canEdit: true`, with the audience) and
  for readers (`readerVisible`, `canEdit: false`, `audience: []` so private principals stay hidden);
  everyone else gets 404. An admin who is not the owner opening a draft writes an `audit_event`.
- Mutations (`PATCH`, upload, publish, retract, replace) require `authorAccessible` and answer 404
  otherwise. `PATCH` bumps `content_epoch` explicitly so link/chapter edits also invalidate caches.
- Upload: `POST /v1/content/:id/upload/init` (or `/replace` for a new version) inserts a
  `content_version` (`status = 'uploaded'`, `processing_step = 'awaiting_upload'`) with
  `original_key = orgs/{org}/content/{content}/versions/{version}/original/{uuid}`, starts an S3 multipart
  upload and returns presigned `UploadPart` URLs (`UPLOAD_URL_TTL_SECONDS`, path-style against
  `S3_ENDPOINT`). `POST /v1/content/:id/upload/complete` completes the multipart upload, HEADs the object,
  refuses a size that differs from the declared one (400 `size_mismatch`), sets `processing_step =
'uploaded'` and emits `content.version_uploaded` (outbox) for the worker, which owns every later status
  transition (`platform_version_update`). Completing twice is 409.
- Publish: `POST /v1/content/:id/publish` diffs the audience against the content's `viewer` tuples,
  writes new targets with `writeTuple` and removes dropped ones with `deleteTuple` (all ADR-0002 rules,
  e.g. 403 `stream_forbidden`, `org_wide_forbidden`), then calls `content_publish(publish_at, expires_at)`.
  Events: `content.published` when `publishAt` is null or past, otherwise `content.scheduled`
  `{publishAt, expiresAt}`; plus `content.expiry_scheduled` `{expiresAt}` when an expiry is set. Publishing
  requires an uploaded version (409 `no_media`) and is refused for retracted items.
- Retract: `POST /v1/content/:id/retract` calls `content_retract` (versions become `retracted`,
  `media_key_id` rotates) and emits `content.retracted` with the version that was current.
- `POST /v1/content/:id/view` records a view with `record_view` only for the current version of a
  reader-visible item (409 `stale_version` otherwise).

## Feed, sync and notifications

- `GET /v1/feed` runs one query inside `withTenant`: epochs are read first (`readEpochs`, ADR-0004
  key-read ordering), then content joined to its current version (`status = 'current'`, `assets ? 'hls'`)
  with `readerVisibleSql` in `WHERE`, ordered by `publish_at desc, id desc`; `cursor` is
  base64url(`[publish_at, id]`). `streamId` filters to items addressed to a stream the caller can access.
  `streams` lists only streams the caller can access. Media URLs are relative proxy paths.
- `GET /v1/sync` returns the caller's `authzEpoch` and the org content epoch.
- `GET /v1/notifications` shows the live title only while the recipient passes `readerVisible` for the
  item; otherwise `title_snapshot` (written by the worker only when the org opts in, ADR-0005) or `null`.

## Media proxy

`GET /media/{contentId}/{versionId}/{path}` maps `path` to
`orgs/{org}/content/{content}/versions/{version}/derived/{path}` and, on **every** request:

1. identifies the caller from the session (cookie or bearer) or, when absent, from `?t=<media token>`
   (token requests are budgeted per the user id the verified token carries, `MEDIA_RATE_LIMIT_MAX`);
2. inside `withTenant` checks that the content exists and is not retracted (else 404), that
   `versionId` is `content.current_version_id` with `status = 'current'` (else 404), that a token's
   signature matches the content's current `media_key_id` (else 403), and that the caller passes
   `readerVisibleSql` (else 403; no credentials at all is 401);
3. streams the object with `Range` support. Playlists (`.m3u8`) are rewritten so URIs stay under the
   proxy (relative URIs kept, absolute storage URLs inside this version's `derived/` prefix mapped to
   `/media/...`, anything else dropped) and are served `Cache-Control: private, no-store`, as are
   captions; segments and images get `private, max-age=60` (ADR-0003 accepted window).

With a token, verification comes first: a token that does not verify against the current media key
(forged, expired, another version, or issued before a retraction rotated the key) always answers 403
`bad_token` and charges the address budget, so an unverified token cannot tell retracted or missing
content from current content. Session (cookie/bearer) paths keep the 404 answers above.

The media token (`GET /v1/content/:id/media-token`, `MEDIA_TOKEN_TTL_SECONDS` ≤ 15 min) is
`v1.<userId>.<orgId>.<exp>.<HMAC-SHA256(MEDIA_HMAC_SECRET, userId|orgId|versionId|mediaKeyId|exp)>`; it is
only a transport for identity, never the authorization decision. When a token is used, rewritten
playlist URIs carry `?t=` so segment requests keep it.

Worker contract: asset values in `content_version.assets` (`hls.master`, `poster`, `sprite`, `spriteVtt`,
`captions.{lang}`) are storage keys under the version's `derived/` prefix (or paths relative to it).

## Configuration (`apps/api/src/config.ts`)

`DATABASE_URL`, `APP_BASE_URL`, `TRUST_PROXY`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (browser-reachable
endpoint used only to presign upload-part URLs; defaults to `S3_ENDPOINT`), `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE`, `SMTP_URL`, `MAIL_FROM`, `SESSION_SECRET`, `MEDIA_HMAC_SECRET`,
`SESSION_TTL_DAYS`, `MAGIC_LINK_TTL_MINUTES`, `INVITE_LINK_TTL_DAYS`, `MEDIA_TOKEN_TTL_SECONDS`,
`UPLOAD_URL_TTL_SECONDS`, `AUTH_RATE_LIMIT_MAX`, `AUTH_EMAIL_RATE_LIMIT_MAX`, `IP_RATE_LIMIT_MAX`,
`SESSION_RATE_LIMIT_MAX`, `MEDIA_RATE_LIMIT_MAX`, `WRITE_RATE_LIMIT_MAX`, `COMMENT_RATE_LIMIT_MAX`,
`SEARCH_RATE_LIMIT_MAX`, `SHARE_RATE_LIMIT_MAX`. In production the process refuses to start with the
compose development defaults for `SESSION_SECRET`, `MEDIA_HMAC_SECRET` or `S3_SECRET_KEY`, with equal
session and media secrets, or with a non-https `APP_BASE_URL`.

## Error contract

Errors are `{error: {code, message, requestId}}`; `code` is stable (`unauthenticated`, `csrf`,
`not_member`, `role_forbidden`, `invalid_credentials`, `invalid_token`, `email_taken`, `slug_taken`,
`already_member`, `content_not_found`, `no_media`, `retracted`, `stale_version`, `size_mismatch`,
`upload_failed`, `bad_cursor`, `bad_expiry`, `validation`, the `writeTuple` rule codes, `internal`; M1b adds
`comments_disabled`, `comment_blocked`, `comment_not_found`, `bad_parent`, `idempotency_mismatch`, `empty_body`,
`body_too_long`, `moderation_forbidden`, `pin_forbidden`, `not_in_audience`, `not_published`, `self_share`,
`stream_not_found`).

## M1b: reactions, comments, share, search, engagement, pins and settings

Every M1b reader path keeps `readerVisibleSql` as its only visibility predicate: likes, comments, shares,
search results, totals and snippets, stats and pins answer 404 `content_not_found` for an item the caller
cannot see, so invisible and missing items are indistinguishable (ADR-0002 side channels). Lists are
cursor-paginated with `limit` at most 50; a malformed cursor is 400 `bad_cursor`.

- `POST`/`DELETE /v1/content/:id/like` are idempotent (`reaction` primary key) and answer
  `{liked, likeCount}` after the call. Likes also appear on feed items and the content detail.
- Comments (`GET`/`POST /v1/content/:id/comments`, `POST /v1/comments/:id/report`,
  `POST /v1/comments/:id/remove`): one nesting level (a reply to a reply attaches to the root); the
  body is NFC-normalised, stripped of control/bidi/zero-width characters and capped at 2000 UTF-16 units
  (400 `empty_body` / `body_too_long`); `clientKey` makes creation idempotent per (author, item) and a
  replay with a different body or parent is 409 `idempotency_mismatch`; the org (`commentsEnabled`) or
  any audience stream (`PATCH /v1/streams/:id {commentsEnabled}`) can switch comments off (409
  `comments_disabled`, existing threads stay readable). Reports are one per reporter; `reportCount`
  shows to moderators only. Removal is allowed to the comment author and to moderators (org owner/admin,
  or moderator/owner of a stream the item is addressed to; the content owner has no moderation right by
  ownership, 403 `moderation_forbidden`); every removal writes `audit_event comment.removed` and leaves a
  tombstone (`state: removed`, no body, no author). The org comment scanner (ADR-0009 §5,
  `commentScanPolicy` off|warn|block) names finding categories only. `comment.created` goes to the
  outbox; the worker notifies the content owner (`commented`) and the root author (`replied`).
- `POST /v1/content/:id/share {userId}` never widens access (ADR-0002): the recipient gets a
  `content.shared` notification only if they already pass `readerVisible`; the response `{delivered,
linkPath}` is identical for unknown, deactivated and no-access recipients, every attempt is an
  `audit_event content.shared`, and the route has its own budget (`SHARE_RATE_LIMIT_MAX`). Retracted or
  expired items cannot be shared (404). The sharer may not share with themselves (400 `self_share`).
- `GET /v1/search?q=&limit=&cursor=&streamId=&tag=` (ADR-0013): `websearch_to_tsquery('simple', q)`
  over `content.search_tsv` (title, description) and the current version's transcript windows in
  `chunk`; `total` counts the same filtered set (capped at 1000); `streamId` and `tag` only narrow.
  Snippets are plain text with `ranges` (UTF-16 code-unit `[start, end)` pairs) and, for transcript hits,
  `tMs` (the window start) so clients open the player there; each hit carries the same `media` object as
  a feed item. The keyset cursor is (score to 6 decimals, publishAt, id). A query without lexemes
  answers an empty page. The request log never contains `q` (the `req` serializer rewrites it).
- `POST /v1/content/:id/engagement {versionId, sessionKey, type, positionMs?}` records `view_start`,
  `progress_25|50|75` and `complete` idempotently per (user, item, version, type, session) through
  `record_engagement`; a stale version is 409 `stale_version`; `recorded: false` on replay or once a user
  used more than 50 session keys for one item in 24 h. A `view_start` after completion (or 75 %) from a
  new session is also counted as `rewatch`; `user_content_state` (progress, watch count, last version,
  title snapshot) is kept current so retraction notices keep targeting viewers (ADR-0005).
  `POST /v1/content/:id/view` (M1a) is unchanged.
- `GET /v1/content/:id/stats` is author-only (`authorAccessible`, 404 otherwise) and reports counts
  computed live from `engagement_event`, `reaction` and visible comments. `viewers` (named rows) is
  present only when the org privacy mode is `named`; the stored default `identified_for_required_only`
  (decision Q1) behaves like `aggregate_only` until required content exists (M4).
- `GET`/`PATCH /v1/org/settings` (`privacyMode`, `commentsEnabled`, `engagementRetentionDays`,
  `commentScanPolicy`; PATCH is owner/admin, merged key by key so other `org.settings` keys survive,
  audited). `GET`/`PATCH /v1/me/preferences {emailDigest: daily|off}` per member.
- `PUT /v1/content/:id/tags {tags}`: closed `EventTag` enum (`onboarding`, `announcement`,
  `current-events`, `training`), at most four, unique; editable by owner/admin/announcer authors
  (`authorAccessible` plus role); the database re-checks the enum (`event_tags_valid`).
- Pins: `POST /v1/content/:id/pin {streamId|null}` and `DELETE /v1/content/:id/pin?streamId=`. Org-wide
  pins need owner/admin/announcer; stream pins also accept that stream's moderator/owner, and the item
  must be addressed to the stream (409 `not_in_audience`); only live published items can be pinned
  (409 `not_published`); pins bump `content_epoch` and are audited. `pinned` on feed and detail is per
  viewer (org pins, or stream pins in streams the viewer can access and the item is still addressed to).
- `GET /v1/feed` accepts `tag=` and `pinned=true` as additional filters; items carry `tags`, `pinned`,
  `likeCount`, `liked`, `commentCount` (visible comments only). `GET /v1/content/:id` carries the same plus
  `commentsEnabled`. `GET /v1/streams` items and `PATCH /v1/streams/:id` carry `commentsEnabled`.
  `PATCH /v1/streams/:id` is accepted from an org owner/admin or the stream's owner only (403
  `role_forbidden` otherwise, including stream moderators); the web shows the switch to exactly those.
- `GET /v1/me` carries `hasPassword`; `POST /v1/auth/password` answers 409 `password_set` before
  hashing when a password exists.
