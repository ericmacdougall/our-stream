# our-stream architecture

Status: draft v0.1, 2026-11-03. Decisions are recorded as ADRs in `docs/adr/`; this document is the map. Items marked "pending research" are confirmed or revised in `docs/research/` once dated official sources are reviewed.

## System overview

```
                 ┌───────────────┐      ┌────────────────┐
  Browser / PWA  │  apps/web     │      │  apps/mobile   │  Expo (iOS/Android)
  (Next.js)      └──────┬────────┘      └──────┬─────────┘
                        │ HTTPS (REST + SSE)   │
                        ▼                      ▼
                 ┌──────────────────────────────────┐
                 │  apps/api  (Node, Fastify, Zod)   │  AuthN, authZ kernel, OpenAPI,
                 │  packages/authz, packages/db      │  SCIM server, webhooks, media proxy
                 └──────┬───────────────┬───────────┘
                        │               │ jobs (outbox -> queue)
                        ▼               ▼
      ┌──────────────────────┐   ┌─────────────────────────┐
      │ Postgres 17 + pgvector│   │ apps/worker              │ transcode, ASR, parse,
      │ RLS, queue, outbox    │   │ packages/pipeline        │ chunk, embed, scan,
      │ tsvector, analytics   │   │ packages/providers       │ notify, rollups, sync
      └──────────────────────┘   └───────────┬─────────────┘
                                             │
                      ┌──────────────────────┼──────────────────────┐
                      ▼                      ▼                      ▼
            ┌───────────────┐      ┌──────────────────┐   ┌──────────────────────┐
            │ S3-compatible │      │ Model providers   │   │ Integrations          │
            │ object store  │      │ (ASR, embed, LLM, │   │ Entra/Okta/Google SSO,│
            │ originals,    │      │ rerank, TTS, video│   │ SCIM, SharePoint,     │
            │ HLS, thumbs   │      │ self-host or ZDR) │   │ Teams, Copilot, GoodQA│
            └───────────────┘      └──────────────────┘   └──────────────────────┘
```

Three deployable processes (`web`, `api`, `worker`) plus Postgres and object storage. Optional sidecars: a self-hosted ASR service (whisper) and an embeddings service, or hosted providers. Everything runs from one `docker compose up`; the Helm chart deploys the same images.

## Monorepo layout (pnpm + Turborepo)

```
apps/
  web/          Next.js (App Router), PWA, feed, upload, ask, dashboards, admin
  api/          Fastify API: REST + OpenAPI, SSE streams, SCIM, webhooks, media auth
  worker/       Job handlers (pg-boss): media, documents, indexing, notifications, sync
  mobile/       Expo Router app: sign-in, feed, ask, notifications (upload from M10)
packages/
  contracts/    Zod schemas and TS types shared by web, api, mobile (API contract)
  db/           Drizzle schema, migrations, RLS policies, seed, test fixtures
  authz/        Permission kernel: readerVisible / authorAccessible / auditorAccessible predicates, tuple writer, epochs
  pipeline/     Media and document processing (ffmpeg, parsers, chunking) as pure functions + adapters
  providers/    Model-provider abstraction with ZDR / residency metadata and policy router
  integrations/ Adapters: identity (oidc, saml, scim), sources (sharepoint), messengers (teams, email), exports (copilot), qa (goodqa)
  notifications/ Fan-out, targeting, templates, digests
  analytics/    Event schema, rollups, dashboard queries
  i18n/         Message catalogs (ICU), locale utilities
  ui/           Shared web components (design tokens, feed player, forms), a11y primitives
  config/       Shared eslint, tsconfig, prettier
infra/
  docker/       Dockerfiles, docker-compose.yml, dev compose with Postgres, storage, whisper
  helm/         Kubernetes chart
  ci/           GitHub Actions workflows
docs/           Brief, architecture, ADRs, research, runbooks, API docs
```

Rule: `apps/*` never import each other; shared logic lives in `packages/*`. Integrations and providers depend on interfaces in `contracts`, never on `apps`.

## Core domain model (summary)

- **Org** (tenant): settings, region, model policy, retention policy, identity config.
- **User**, **Group** (local or synced via SCIM/directory; external ids per IdP), **Membership** (org role: member, contributor, admin, owner).
- **Stream**: kind company | department | team | project | private; roles viewer, contributor, moderator, owner granted to users or groups. Personal stream = private stream with one member.
- **Content**: kind clip | document | page | link | audio; owner; current version; state draft | published | retracted (stored enum; "scheduled" and "expired" are derived display statuses computed from `publish_at` and `expires_at`, never stored); event tags; pinned flags per stream; `requires_ack`.
- **ContentVersion**: immutable source object + derived assets (HLS ladder, thumbnails, captions, transcript, parsed text, chapters), processing status, checksum.
- **Audience**: rows (content_id, stream_id | group_id | user_id | org_wide). Published content is visible if any audience row matches the viewer.
- **Chunk**: (content_version_id, locator: timestamp range or page/slide/cell range, text, tsvector, embedding, lang). Chunks inherit visibility from content via content_version.
- **Engagement**: like, comment (threaded, moderated), share (internal: to stream or user), acknowledgement (per version), view events and per-user content state.
- **Question** log: text, user, retrieved chunk ids, answer, confidence, feedback, resolution state, links to content.
- **Notification**: per-user, channel, dedupe key, reason (audience, saw-old-version, asked-related).
- **Integration**, **ProviderConfig**, **AuditEvent**, **RetentionPolicy**, **LegalHold**.

## Request path and authorization

1. AuthN: session cookie (web) or bearer token (mobile, API) resolves to (org_id, user_id); roles, membership status and `authz_epoch` are read from the database on every request, never carried in a token. Sessions and refresh tokens are revoked on deactivation. The Next.js app never talks to Postgres; it calls the API, which is the single authorization surface.
2. Each request opens a transaction and sets `app.org_id` and `app.user_id`; Postgres RLS denies rows outside the org even if application code has a bug. The API database role cannot bypass RLS. See ADR-0001.
3. Application-level authorization uses `packages/authz` with two named predicates: `readerVisible(viewer, content)` for every reader path (feed, search including counts and facets, retrieval, media, notifications, exports, citations, viewer lists, autocomplete) and `authorAccessible` for editing and moderation endpoints only; an audited `auditorAccessible` path covers old versions. All are generated from one rule set and covered by one fixture matrix with an independent reference implementation. See ADR-0002.
4. Retrieval: vector or keyword search is executed with `readerVisible` in the SQL `WHERE` clause (pgvector iterative scan with an exact-scan fallback) or against a precomputed permitted-content set when the set is small. A post-check asserts every returned chunk satisfies `readerVisible`; a violation fails closed and is logged as a security event. See ADR-0002.
5. Media: HLS playlists, captions and every segment are served through an authenticated proxy route that re-authorises each request (active user, current version, `readerVisible`); native players receive a short-lived identity token in segment URLs but the server check is the authorization. See ADR-0003 and ADR-0004.

## Content pipeline

Upload (presigned multipart to object storage) → `content_version` created → jobs:

- Video/audio: `probe` → `transcode` (fMP4 HLS ladder, vertical-aware) → `thumbnails` (poster, sprite) → `asr` (segments with timestamps, language detect) → `captions` (WebVTT, editable) → `chapters` (manual in M1, suggested in M2) → `index` (tsvector M1, chunks+embeddings M2).
- Documents: `parse` (PDF, DOCX, PPTX, XLSX, MD, HTML; OCR fallback) → text with locators → `chunk` → `embed` → `index`.
- Optional: `scan` (PII/secrets) before publish; `translate` (M7); `tts`/`video-gen` for created clips (M10).

Versioning: derived artifacts live under `orgs/{org}/content/{content}/versions/{version}/...`; publishing a new version switches `current_version_id`; old versions stay for audit until retention. See ADR-0003.

## Caching and invalidation

Epoch-keyed caches: each user has an `authz_epoch` (bumped by membership, group, stream-role or audience changes affecting them) and each content item a `content_epoch` (bumped on version publish, retraction, metadata edits). Cache keys embed epochs, so stale entries are unreachable without explicit purge. Personalized HTTP responses are `private, no-store`; media is immutable-per-version and served by a proxy route that re-authorises every request (signed cookies only in CDN mode); CDN purge by version prefix on retraction. Epoch values for a cache key are read inside the same transaction snapshot as the query they key, before the query runs. Retrieval always re-checks version state in SQL so a cache lag can never resurface retracted content. See ADR-0004.

## Notifications and targeting

Domain events go to an outbox table in the same transaction as the change; the worker fans out to recipients computed by audience resolution and targeting rules ("viewed version N", "asked a question whose answer cited content X", "acknowledged old version"). Channels: in-app, email, Teams (M6), Expo push (M10). Per-user preferences, digest batching, dedupe keys, rate limits. See ADR-0005.

## Analytics

Append-only event table (partitioned), hourly rollups, per-user content state. Dashboards query rollups, not raw events. Question analytics cluster similar questions (embedding + canonicalization) and compute resolved/unresolved; a batch job produces labelled AI suggestions. Privacy switches per org for identified vs aggregate viewing. See ADR-0006.

## Integrations as adapters

Each integration implements a small interface in `packages/contracts` and lives in `packages/integrations/<name>` with a fake for tests. Identity: OIDC, SAML, SCIM server. Sources: SharePoint (Graph delta + ACL mirror). Messengers: Teams, email. Exports: Copilot connector (externalItems with ACL). Q&A: GoodQA. Secrets per org encrypted with envelope keys. See ADR-0007.

## Model providers

`packages/providers` exposes capabilities (asr, embed, chat, rerank, tts, video, translate). Every provider declares vendor, regions, retention class (self-hosted, zdr-contractual, default-retention, unknown), training-use statement and residency. Org policy (allowed vendors/regions, require ZDR, self-host only) is enforced by the router before any call; every call is audited with metadata only. See ADR-0008.

## PII and secret scanning

Optional per-org job on upload; regex and entropy detectors in-process, Presidio sidecar optional; policy warn / review / block; findings stored as type + locator, never the value. See ADR-0009.

## Prompt-injection and model safety

Authorization is enforced outside the model; retrieved text is wrapped as untrusted data with provenance; the assistant has read-only retrieval and no actions in M2; citations are validated against the permitted set before rendering; links in documents are rendered as untrusted; red-team corpus with injected instructions is part of CI. See ADR-0010.

## Deployment

- Dev and evaluation: `docker compose up` (postgres+pgvector, object storage, api, web, worker, whisper sidecar optional).
- Production self-host: Helm chart (api, web, worker deployments; HPA; Postgres via operator or managed; object storage external; secrets via K8s secrets or external secrets).
- Hosted SaaS: same images, per-region cells, org pinned to a region, isolated storage buckets per region, no cross-region replication of customer data.

## Observability and operations

OpenTelemetry traces across api → queue → worker; structured JSON logs (pino) with redaction of tokens, emails and content text; metrics for queue depth, transcode time, retrieval latency, leak-check violations (must be zero), notification delivery. Health and readiness endpoints; migrations run as a job before rollout; backups and restore rehearsal documented.

## Security baseline

- AGPL-3.0, no secrets in repo, dependency lockfile and audit in CI, SBOM.
- Session: HttpOnly Secure SameSite=Lax cookies for web; short-lived access + refresh tokens for mobile stored in secure storage; CSRF for cookie-authenticated mutations.
- Rate limits on auth, upload, ask, comments; upload size and type limits; antivirus hook point (ClamAV optional).
- Media only through the re-authorising proxy route (or signed cookies in CDN mode); no public buckets; object keys are opaque.
- Audit log for every administrative and publishing action.
- Threat model and red-team findings tracked in `docs/security/`.
