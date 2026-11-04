# API (M1a): sessions, CSRF, uploads, publishing, feed and media

The API in `apps/api` is the single authorization surface (ADR-0011). Every route is declared with the
Zod schemas in `packages/contracts/src/m1a.ts`, so `pnpm contracts:generate` regenerates the typed
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
exempt. Sign-in routes have no session yet and are instead rate limited (`AUTH_RATE_LIMIT_MAX` per IP
per minute; 429).

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

1. identifies the caller from the session (cookie or bearer) or, when absent, from `?t=<media token>`;
2. inside `withTenant` checks that the content exists and is not retracted (else 404), that
   `versionId` is `content.current_version_id` with `status = 'current'` (else 404), that a token's
   signature matches the content's current `media_key_id` (else 403), and that the caller passes
   `readerVisibleSql` (else 403; no credentials at all is 401);
3. streams the object with `Range` support. Playlists (`.m3u8`) are rewritten so URIs stay under the
   proxy (relative URIs kept, absolute storage URLs inside this version's `derived/` prefix mapped to
   `/media/...`, anything else dropped) and are served `Cache-Control: private, no-store`, as are
   captions; segments and images get `private, max-age=60` (ADR-0003 accepted window).

The media token (`GET /v1/content/:id/media-token`, `MEDIA_TOKEN_TTL_SECONDS` ≤ 15 min) is
`v1.<userId>.<orgId>.<exp>.<HMAC-SHA256(MEDIA_HMAC_SECRET, userId|orgId|versionId|mediaKeyId|exp)>`; it is
only a transport for identity, never the authorization decision. When a token is used, rewritten
playlist URIs carry `?t=` so segment requests keep it.

Worker contract: asset values in `content_version.assets` (`hls.master`, `poster`, `sprite`, `spriteVtt`,
`captions.{lang}`) are storage keys under the version's `derived/` prefix (or paths relative to it).

## Configuration (`apps/api/src/config.ts`)

`DATABASE_URL`, `APP_BASE_URL`, `TRUST_PROXY`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE`, `SMTP_URL`, `MAIL_FROM`, `SESSION_SECRET`, `MEDIA_HMAC_SECRET`,
`SESSION_TTL_DAYS`, `MAGIC_LINK_TTL_MINUTES`, `INVITE_LINK_TTL_DAYS`, `MEDIA_TOKEN_TTL_SECONDS`,
`UPLOAD_URL_TTL_SECONDS`, `AUTH_RATE_LIMIT_MAX`. In production the process refuses to start with the
compose development defaults for `SESSION_SECRET`, `MEDIA_HMAC_SECRET` or `S3_SECRET_KEY`, with equal
session and media secrets, or with a non-https `APP_BASE_URL`.

## Error contract

Errors are `{error: {code, message, requestId}}`; `code` is stable (`unauthenticated`, `csrf`,
`not_member`, `role_forbidden`, `invalid_credentials`, `invalid_token`, `email_taken`, `slug_taken`,
`already_member`, `content_not_found`, `no_media`, `retracted`, `stale_version`, `size_mismatch`,
`upload_failed`, `bad_cursor`, `bad_expiry`, `validation`, the `writeTuple` rule codes, `internal`).
