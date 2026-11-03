# Research: job queue, API framework, ORM, authorization engines, caching, storage, observability, Helm, licensing

Researched 2026-11-03 from official pages, registries and repositories. [V] verified, [I] inference. Confidence in parentheses.

## Job queue

- pg-boss 12.38.0 (2026-10-13), MIT, Node >= 22.12, Postgres 13+: https://pgboss.io/ and https://github.com/timgit/pg-boss/releases (high). [V] Retries with backoff, cron and RRULE, deferral, rate limiting, singleton policies, pub/sub, dead-letter queues, OpenTelemetry, polling plus optional LISTEN/NOTIFY, transactional enqueue adapters for Drizzle and others, `@pg-boss/dashboard`.
- Graphile Worker 0.18.0 (2026-09-08), MIT, pure ESM, pre-1.0 (high).
- BullMQ 6.5.4 MIT requires Redis; Pro is commercial (high).
- Postgres NOTIFY limits https://www.postgresql.org/docs/current/sql-notify.html (high): payload < 8000 bytes, delivered on commit, not durable or cross-replica; always pair with polling.

Decision: pg-boss 12 (Postgres-only self-host). Add Valkey/BullMQ only if throughput demands it.

## API framework

- Fastify 5.12.8 (2026-11-02), MIT, Node 20+; `@fastify/swagger` 9.9.3 (high). Hono 4.13.16 with `@hono/node-server` 2.1.6 (high). NestJS 12 ESM-only (high). tRPC 11.24 (OpenAPI generation unverified, low). oRPC 1.16.1 with 2.0 in beta (medium on stability). ts-rest 3.52.1 (high). zod-openapi 6.0.2 for zod 4 (high).

Decision: Fastify 5 with a Zod type provider and `@fastify/swagger` producing OpenAPI 3.1 as the single contract; typed clients for web and mobile generated from the spec (`openapi-typescript` + `openapi-fetch`, MIT); SSE for streaming answers. No RPC framework: avoids oRPC v2 churn and keeps REST as the integration surface.

## ORM and migrations

- Drizzle ORM `latest` 0.45.4, `rc` 1.0.0-rc.5; drizzle-kit 0.31.11 / 1.0.0-rc.5; Apache-2.0 (medium on license re-read). [V] RLS via `pgPolicy`, `pgRole`, `withRLS()`; pgvector types and HNSW index helpers; https://orm.drizzle.team/docs/rls and /docs/extensions/pg (high).
- Prisma 7.10.1 GA Rust-free, 8 RC; pgvector still `Unsupported` (medium). Kysely 0.29.8 MIT.

Decision: Drizzle, pinned exactly (1.0 RC if it passes the scaffold smoke test, else 0.45.x), raw `sql` for vector queries.

## Authorization engines

- OpenFGA v1.22.1 (2026-10-27), Apache-2.0; ListObjects capped at 1,000 and CPU-heavy: https://openfga.dev/docs/interacting/relationship-queries (high).
- SpiceDB v1.57.0 (2026-10-20), Apache-2.0; LookupResources guidance under ~10k accessible resources, CheckBulkPermissions for larger sets: https://authzed.com/docs/spicedb/modeling/protecting-a-list-endpoint (high).
- Oso OSS library archived; Oso Cloud hosted (high). Permit.io needs its cloud control plane (medium). Cerbos v0.57.0 Apache-2.0 with `PlanResources` to Drizzle/Prisma query plans (high). Casbin 5.51.1 Apache-2.0, no query-plan filtering (high).
- pgvector 0.8.7 filter semantics: WHERE applies after ANN scan; iterative scans, partial indexes, partitioning (high).

Decision (ADR-0002): Postgres-native ACL tuples shaped like OpenFGA tuples (object, relation, subject) plus materialised effective access and RLS; deterministic, single round trip, pushable into the vector query. Cerbos optional later for UI policy. External ReBAC engines cannot be pushed into pgvector queries and cap list operations.

## Caching and invalidation

- Next.js 16.4.5: `"use cache"` stable behind `cacheComponents`; `cacheTag`, `cacheLife`, `updateTag`, `revalidateTag(tag, 'max' | {expire})` (single-arg deprecated); `'use cache: private'` is never stored server-side across requests; `cacheHandlers` for remote caches: https://nextjs.org/docs/app/api-reference/directives/use-cache (2026-09-29), /functions/revalidateTag (2026-08-25), /directives/use-cache-private (2026-10-15) (high). Permissioned data must never be in plain `use cache`.
- Redis 8+ tri-licensed RSALv2/SSPL/AGPLv3; Valkey 9.1.3 BSD-3 (high). Standardise on Valkey if a cache server is enabled.
- Cloudflare purge by tag/prefix on all plans; CloudFront tag invalidation now exists (`CacheTagConfig`) (high).

## Storage and media

- MinIO community archived 2026-04-25, "no longer maintained"; AIStor is proprietary (high). Do not adopt.
- Garage AGPL-3.0 (medium-high); SeaweedFS Apache-2.0 with S3 gateway, multipart, presigned URLs, versioning, Object Lock (high); RustFS Apache-2.0 early (medium).
- AWS SDK v3 `@aws-sdk/client-s3` 3.1161.0 Apache-2.0; presigned URLs up to 7 days; browser multipart with presigned parts, CORS must expose `ETag` (high).
- Uppy MIT with `@uppy/aws-s3` 6.3.1 browser multipart via server-signed URLs, Companion not required (high). tus `@tus/server` 2.4.7 MIT with S3 store if cross-session resumability is needed (high).

Decision: S3 API everywhere; SeaweedFS as the bundled dev/self-host store (Garage documented as alternative); Uppy + `@uppy/aws-s3` multipart; tus later if needed.

## Observability and Helm

- OpenTelemetry JS SDK 3.0.0 (2026-10-20), Node >= 22.15; traces and metrics stable, logs in development (high). pino 10.4.0 MIT (high). Sentry self-hosted FSL-1.1 (operate, do not bundle); `@sentry/node` MIT (high).
- Bitnami public catalog effectively discontinued since 2025-08-28; use CloudNativePG 1.30.1 (Apache-2.0, CNCF) for Postgres on Kubernetes (high).

Helm pattern: umbrella chart with `web`, `api`, `worker` deployments, `migrate` pre-upgrade Job, HPA, PDB, NetworkPolicy, CloudNativePG `Cluster` with pgvector image, external S3 by default with optional SeaweedFS subchart, optional Valkey.

## Licensing

Fine to include (MIT/Apache-2.0/BSD/PostgreSQL): pg-boss, Fastify, Drizzle, pgvector, AWS SDK, Uppy, tus, OTel, pino, `@sentry/node`, Valkey, SeaweedFS, CloudNativePG, openid-client, node-saml, SimpleWebAuthn, otplib, hls.js, Serwist. Garage and MinIO are AGPL-3.0: deploy as separate services, do not vendor. Avoid or isolate: Redis >= 7.4 under RSAL/SSPL (use Valkey), Sentry self-hosted (FSL; operate only), BullMQ Pro, MinIO AIStor, Bitnami Secure Images, Oso Cloud, Permit.io, Authzed Materialize, ParadeDB and VectorChord unless the AGPL duality is acceptable.

## Deprecations

MinIO community; Oso OSS; `@hono/node-ws`; `revalidateTag(tag)` single argument; Next `dynamicIO`/experimental `useCache` flags; Bitnami public catalog; OpenTelemetry JS 2.x superseded; `trpc-openapi` archived; Redis <= 7.2 BSD line unmaintained.
