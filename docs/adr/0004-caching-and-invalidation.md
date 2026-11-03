# ADR-0004: Caching and automatic invalidation

Status: proposed, 2026-11-03. Confidence: high.

## Context

The feed, search and answers are personalised and permissioned, so most responses cannot be shared across users. Media is heavy and benefits from caching. Content is retracted or changed and must disappear everywhere immediately, including from caches, CDNs, search indexes and any downstream exports. Next.js 16 CVEs (2026-11-03 security release) involved cross-tenant cache disclosure in Cache Components, which reinforces that permissioned data must never live in shared framework caches.

## Decision

1. **Epoch keys.** Two monotonic counters drive every cache key:
   - `user.authz_epoch` increments when anything changes what that user may see (org role, group membership closure, stream role, direct grant, deactivation). Revocations bump affected users' `authz_epoch` in the same transaction as the change, including bulk changes such as removing a 10k-member group (ADR-0002); only grants may bump epochs from the reconcile job.
   - `content.content_epoch` increments on any publish, version switch, metadata edit, audience change, pin/unpin, expiry or retraction.
   - An org-level `org_content_epoch` implemented as a per-org Postgres sequence (not a single updated row, which would serialise bulk writes) is advanced whenever any `content_epoch` in the org changes; list caches read its current value.
   - **Time-driven transitions**: `publish_at` and `expires_at` do not write rows by themselves, so a scheduled job (ADR-0003) bumps the item's `content_epoch` and the org sequence at the transition instant. In addition, every list and permitted-set cache key includes a `time_bucket` (floor of now to 60 s) and the entry TTL is capped at the time to the org's next known transition, whichever is sooner.
   One key definition is used everywhere: lists and permitted sets `(org, user, authz_epoch, org_content_epoch, time_bucket, filters)`; items `(org, content, content_epoch)`. Stale entries become unreachable; no purge is required for correctness, only for memory.
   `authz_epoch` and membership status are read from the database per request (cheap indexed read), never from a token.
2. **Where caches live.** Default: in-process LRU in the API (small, per instance) plus Postgres materialisations. Optional Valkey (BSD) for multi-instance sharing, enabled by config. Never Redis ≥ 7.4 under RSAL/SSPL.
3. **HTTP semantics.** Any response that depends on identity carries `Cache-Control: private, no-store` and `Vary: Cookie, Authorization`, and no ETag (ETag with `no-store` is contradictory; clients use the `/sync` epochs instead). Only org-anonymous assets (logos, i18n catalogs, public manifests) are shared-cacheable with ETags. The service worker never caches `/api` or `/media` and clears caches on logout or epoch change.
4. **Next.js.** Personalised pages are dynamic. `"use cache"` with `cacheTag` is used only for org-anonymous data; `'use cache: private'` is acceptable for per-request memoisation. `revalidateTag(tag, 'max')` is called on org-anonymous changes. No permissioned data in `"use cache"` ever; an ESLint rule bans importing permissioned data accessors into cached functions.
5. **Media.** Immutable per-version paths; every proxy request re-authorises (ADR-0003); playlists and captions `no-store`, segments `private, max-age=60`. In CDN mode, retraction purges by version prefix or tag (Cloudflare tag purge, CloudFront tag invalidation) and the exposure window is cookie TTL plus purge lag, documented.
6. **Search and retrieval.** Indexed chunks carry `content_version_id`; SQL joins `content_version.status = 'current'` and `readerVisible` on every query, so retracted or superseded content is excluded even before the index job removes it. The per-user permitted-set cache uses the single key definition in point 1.
7. **Clients.** Web and mobile keep the epochs they last saw; a lightweight `/sync` endpoint returns the current epochs so clients drop local caches (feed pages, played media) when they change; push/SSE delivers `content.retracted` so an open player stops within seconds.
8. **Downstream exports.** Copilot connector items are keyed by `content_version_id` and deleted on retraction in the same fan-out as notifications (ADR-0005).

## Consequences

- Correctness never depends on purge success; purges only reclaim memory and CDN storage.
- Epoch bumps for revocations happen inside the same transaction as the change (ADR-0002); grants may lag (availability only). Time-driven transitions are covered by the scheduled bump plus the 60 s time bucket, so the worst-case staleness for an expiry is 60 s on cached lists and zero on the SQL predicate itself.
- Trade-off: a large group change invalidates many users' caches at once (thundering herd on the feed); mitigated by jittered client refresh and the feed query being index-only on materialised tables.

## Tests

- Retract while cached: feed page cached → retract → next request (same instance, same user) excludes the item without any purge call (epoch changed).
- Permission revoked while cached: same for `authz_epoch`, including removing a 10k-member group while the feed and permitted set are cached; the next request excludes the item with no job run.
- Media: segment request after retraction or revocation fails on the next request in proxy mode; CDN purge call recorded (fake adapter).
- Expiry with a cached list: an item whose `expires_at` passes disappears from the cached feed within 60 s without any write (fake clock).
- Deactivated user with a live session: next feed, media and `/sync` request fails.
- Lint: no permissioned accessor inside `"use cache"` functions; integration test asserts `private, no-store` on all authenticated routes.
