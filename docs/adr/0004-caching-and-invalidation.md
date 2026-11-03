# ADR-0004: Caching and automatic invalidation

Status: proposed, 2026-11-03. Confidence: high.

## Context

The feed, search and answers are personalised and permissioned, so most responses cannot be shared across users. Media is heavy and benefits from caching. Content is retracted or changed and must disappear everywhere immediately, including from caches, CDNs, search indexes and any downstream exports. Next.js 16 CVEs (2026-11-03 security release) involved cross-tenant cache disclosure in Cache Components, which reinforces that permissioned data must never live in shared framework caches.

## Decision

1. **Epoch keys.** Two monotonic counters drive every cache key:
   - `user.authz_epoch` increments when anything changes what that user may see (org role, group membership closure, stream role, direct grant, deactivation). Bulk changes (group of 10k users) bump epochs in the same reconcile job that updates materialised access.
   - `content.content_epoch` increments on any publish, version switch, metadata edit, audience change, pin/unpin, expiry or retraction.
   - An org-level `org.content_epoch_max` (max over content, maintained by trigger) lets list caches be keyed cheaply.
   Cache keys embed `(org, user, authz_epoch, org_content_epoch_max, filters)` for lists and `(content, content_epoch)` for items. Stale entries become unreachable; no purge is required for correctness, only for memory.
2. **Where caches live.** Default: in-process LRU in the API (small, per instance) plus Postgres materialisations. Optional Valkey (BSD) for multi-instance sharing, enabled by config. Never Redis ≥ 7.4 under RSAL/SSPL.
3. **HTTP semantics.** Any response that depends on identity carries `Cache-Control: private, no-store` and `Vary: Cookie, Authorization`. Only org-anonymous assets (logos, i18n catalogs, public manifests) are shared-cacheable. ETags on personalised JSON are allowed for browser revalidation only.
4. **Next.js.** Personalised pages are dynamic. `"use cache"` with `cacheTag` is used only for org-anonymous data; `'use cache: private'` is acceptable for per-request memoisation. `revalidateTag(tag, 'max')` is called on org-anonymous changes. No permissioned data in `"use cache"` ever; an ESLint rule bans importing permissioned data accessors into cached functions.
5. **Media.** Immutable per-version paths; short-lived signed tokens or cookies (ADR-0003). Retraction rotates the content's signing key id and purges CDN by version prefix or tag (Cloudflare tag purge, CloudFront tag invalidation). Signed-URL TTL ≤ 10 min bounds the exposure window if purge lags.
6. **Search and retrieval.** Indexed chunks carry `content_version_id`; SQL joins `content_version.status = 'current'` and the visibility predicate on every query, so retracted or superseded content is excluded even before the index job removes it. The per-user permitted-set cache is keyed by `authz_epoch` and `org_content_epoch_max`.
7. **Clients.** Web and mobile keep the epochs they last saw; a lightweight `/sync` endpoint returns the current epochs so clients drop local caches (feed pages, played media) when they change; push/SSE delivers `content.retracted` so an open player stops within seconds.
8. **Downstream exports.** Copilot connector items are keyed by `content_version_id` and deleted on retraction in the same fan-out as notifications (ADR-0005).

## Consequences

- Correctness never depends on purge success; purges only reclaim memory and CDN storage.
- Epoch bumps are cheap row updates inside the same transaction as the change; no eventual consistency for correctness.
- Trade-off: a large group change invalidates many users' caches at once (thundering herd on the feed); mitigated by jittered client refresh and the feed query being index-only on materialised tables.

## Tests

- Retract while cached: feed page cached → retract → next request (same instance, same user) excludes the item without any purge call (epoch changed).
- Permission revoked while cached: same for `authz_epoch`.
- Media: token minted before retraction fails after key rotation; CDN purge call recorded (fake adapter).
- Lint: no permissioned accessor inside `"use cache"` functions; integration test asserts `private, no-store` on all authenticated routes.
