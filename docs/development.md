# Development guide

## Prerequisites

- Node 24 (pinned via `.npmrc` `use-node-version`, so pnpm fetches it automatically), pnpm 10+, Docker with Compose v2, ffmpeg (worker, from M1a), psql (optional).
- Postgres with pgvector for integration tests. The compose stack provides one.

## Layout

See `docs/architecture.md`. `apps/*` are deployables, `packages/*` are shared libraries, `infra/*` holds Docker and Kubernetes.

## Commands

```sh
pnpm install
pnpm lint            # eslint + prettier
pnpm typecheck
pnpm test            # unit tests (no database)
pnpm db:migrate      # applies packages/db/migrations with DATABASE_ADMIN_URL, then schema lint
pnpm test:integration  # needs DATABASE_ADMIN_URL and DATABASE_URL (RLS-bound app role); the API suites also need S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY
pnpm headers:check && pnpm licenses:check
pnpm contracts:generate   # emit OpenAPI from the API and regenerate typed client types
```

## Running the API alone

```sh
# Postgres (with the dev roles) and SeaweedFS as in the compose files:
docker run -d --name os-pg -e POSTGRES_USER=ourstream_admin -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=ourstream \
  -e APP_DB_PASSWORD=ourstream-app-dev-only -e PLATFORM_DB_PASSWORD=ourstream-platform-dev-only \
  -p 127.0.0.1:5432:5432 -v "$PWD/infra/docker/postgres/init:/docker-entrypoint-initdb.d:ro" pgvector/pgvector:pg17
docker run -d --name os-s3 -p 127.0.0.1:8333:8333 -v "$PWD/infra/docker/seaweedfs/s3.json:/etc/seaweedfs/s3.json:ro" \
  chrislusf/seaweedfs:3.97 server -s3 -s3.port=8333 -dir=/data -s3.config=/etc/seaweedfs/s3.json
export DATABASE_ADMIN_URL=postgres://ourstream_admin:dev@127.0.0.1:5432/ourstream
export DATABASE_URL=postgres://ourstream_app:ourstream-app-dev-only@127.0.0.1:5432/ourstream
export S3_ENDPOINT=http://127.0.0.1:8333 S3_ACCESS_KEY=ourstream-dev S3_SECRET_KEY=ourstream-dev-secret-only
pnpm db:migrate
pnpm --filter @our-stream/api dev        # http://localhost:4000/health, /openapi.json
pnpm --filter @our-stream/api test:integration
```

`docs/api.md` describes sessions, CSRF, uploads, publishing, the feed and the media proxy.

## Web app (apps/web)

The web app only ever calls the API (ADR-0011): the browser hits same-origin `/api/*` and `/media/*`,
which `next.config.ts` rewrites to `API_INTERNAL_URL` (fixed at build time; the Docker build takes it
as a build arg). See `apps/web/README.md` for the full map.

```sh
pnpm --filter @our-stream/contracts build
pnpm --filter @our-stream/web mock-api                                      # contract mock on :4100 (ffmpeg optional)
API_INTERNAL_URL=http://127.0.0.1:4100 pnpm --filter @our-stream/web dev    # or point at a real API on :4000
pnpm --filter @our-stream/web exec playwright install --with-deps chromium
pnpm --filter @our-stream/web test:e2e                                      # Playwright against the mock
E2E_API_URL=http://localhost:4000 pnpm --filter @our-stream/web test:e2e    # same suite against a real stack
```

## Database roles

Migrations run as the owner/admin role (`DATABASE_ADMIN_URL`). The API and tenant jobs connect as `ourstream_app` (`DATABASE_URL`), which has no `BYPASSRLS` and owns nothing; every tenant query runs inside `withTenant()` which sets `app.org_id`/`app.user_id` with `SET LOCAL`. The worker's platform jobs connect as `ourstream_platform` (`DATABASE_PLATFORM_URL`) for pg-boss and the outbox. `infra/docker/postgres/init/01-roles.sql` creates the dev roles; CI creates them inline.

## Compose

```sh
docker compose -f infra/docker/docker-compose.yml up --build
# app http://localhost:3000 (Caddy edge in front of web and api), api http://localhost:4000/health,
# mail http://localhost:8025, S3 http://localhost:8333
```

`localhost:3000` is the `edge` service (Caddy): it sends `/api/*` and `/media/*` to the api and everything
else to web, which publishes no host port of its own. Ports, network addresses and the client-address
trust chain are described in `docs/deployment.md`.

## Worker and media pipeline

`apps/worker` runs pg-boss under the platform role (`DATABASE_PLATFORM_URL`). It drains `platform.domain_event` every 5 s (`OUTBOX_DRAIN_INTERVAL_MS`) plus a once-a-minute cron, and reaches tenant rows only through the `platform_*` definer functions (migrations 0002/0003):

| event                                           | effect                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content.version_uploaded` (`version_id` set)   | enqueue `media.process` (singleton per version, 3 retries with backoff)                                                                                                            |
| `content.scheduled`, `content.expiry_scheduled` | read `publish_at`/`expires_at` from the database and enqueue `content.transition` jobs at those instants (payload times are ignored)                                               |
| `content.published`                             | one `content.published` notification per member in `platform_audience_of_content`, dedupe `published:{versionId}`                                                                  |
| `content.retracted`                             | one `content.retracted` notice per viewer of that version, dedupe `retracted:{versionId}`; title snapshot only with `org.settings.notify.include_title_after_access_loss = "true"` |
| `comment.created` (M1b)                         | one `comment.created` notice to the content owner (`commented`) and the root comment's author (`replied`), never the commenter; dedupe `comment:{commentId}`                       |

`media.process` downloads the original from S3 (`S3_*`, path style), probes it, transcodes an HLS fMP4 ladder (vertical-aware, never upscaled, 2 s GOP, 4 s segments, AAC 128k; audio-only rendition for audio uploads), renders a poster, a 10x10 sprite sheet with a WebVTT thumbnails track, runs ASR, writes WebVTT captions, uploads everything under `.../versions/{version}/derived/` and finally calls `platform_version_update(status 'current')`, which makes the version current. Failures persist `status = 'failed'` with a path-free `processing_error`. Limits: `FFMPEG_THREADS` (4), `FFMPEG_TIMEOUT_MS` (30 min), `FFPROBE_TIMEOUT_MS`, `MEDIA_MAX_INPUT_BYTES` (4 GiB), `WORKER_TMP_DIR`, `FFMPEG_PRESET` (`veryfast`), `MEDIA_CONCURRENCY` (1).

### Scheduled jobs (M1b)

| queue                  | schedule (env override)           | effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notify.digest`        | `0 6 * * *` UTC (`DIGEST_CRON`)   | One email per member per day (`email_digest` claim row; `platform_digest_claim` marks the notifications digested in the same call) listing unread, undigested notifications of the last two days; titles are resolved by the database with `readerVisible` at build time, so a title the member can no longer see is replaced by a neutral line; members with `emailDigest = off` and deactivated members are skipped. A failed send is marked `failed` and retried on later runs of the same day (at most 3 attempts) with re-resolved items; a claim left `pending` by a crash before the mark is retried the same way after 30 minutes, so a crash between a successful send and the mark can repeat one email (accepted). Worker logs carry an address handle (sha256 prefix), never the address; with `SMTP_URL` set the worker refuses to start without `APP_BASE_URL` (https in production). Mail goes through `SMTP_URL`/`MAIL_FROM` (the `LoggingMailer` logs recipient and subject only when SMTP is unset); links use `APP_BASE_URL`. Migration 0010 marks every pre-existing notification digested, so the first run never emails the backlog. |
| `engagement.retention` | `30 3 * * *` (`RETENTION_CRON`)   | Deletes raw `engagement_event` rows older than the org's `engagementRetentionDays` (default 395, decision Q12) in batches of 5000 through `platform_engagement_prune`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `search.prune`         | `0 4 * * *` (`SEARCH_PRUNE_CRON`) | Deletes `chunk` rows of non-current versions (`platform_search_prune`); the search query joins `content_version.status = 'current'`, so this is hygiene, not correctness (ADR-0013).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `search.reindex`       | on demand (`{orgId}` job)         | Rebuilds an org's transcript windows (`platform_search_reindex`), for example after changing the window size.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The transcript index itself is built by a database trigger in the transaction that makes a version current (migration 0009), not by a job.

The worker exposes `GET /health` on `HOST` (default `127.0.0.1`) port `WORKER_HEALTH_PORT` (default 4001): 200 `{status: ok, bossStarted, lastDrainAt, lastDrainOk, uptimeSeconds}` while pg-boss is up and an outbox drain completed within three drain intervals (one minute of start-up grace), otherwise 503 `degraded`. Helm and compose probe this port; it serves nothing else.

### ASR providers (ADR-0008)

`ASR_PROVIDER=fake` (default) produces deterministic placeholder segments and needs no model. `ASR_PROVIDER=whisper-http` sends a 16 kHz mono WAV to a self-hosted whisper.cpp server (`WHISPER_URL`, default `http://whisper:8080`; `WHISPER_TIMEOUT_MS`). The deployment policy is self-host-only and ZDR by default (`PROVIDER_SELF_HOST_ONLY`, `PROVIDER_REQUIRE_ZDR`); a provider outside the policy makes the worker refuse to start rather than fall back.

Compose ships the sidecar as the optional `whisper` profile (`ghcr.io/ggml-org/whisper.cpp:main`, CPU). Download a model into the `whisper-models` volume once, then start the stack with the profile:

```sh
docker compose -f infra/docker/docker-compose.yml run --rm whisper download-ggml-model.sh base /models   # ~150 MB; `small`, `medium`, `large-v3-turbo` also work
ASR_PROVIDER=whisper-http WHISPER_MODEL=ggml-base.bin docker compose -f infra/docker/docker-compose.yml --profile whisper up --build
```

Running the worker outside compose: `DATABASE_URL=... DATABASE_PLATFORM_URL=... S3_ENDPOINT=http://127.0.0.1:8333 S3_BUCKET=ourstream S3_ACCESS_KEY=... S3_SECRET_KEY=... pnpm --filter @our-stream/worker dev`. The worker integration test (`pnpm --filter @our-stream/worker test:integration`) needs `DATABASE_ADMIN_URL`, `DATABASE_PLATFORM_URL`, the `S3_*` variables and ffmpeg; it generates its test clip with ffmpeg at run time, so no media fixtures live in the repository.

## Permission rules

The authorization rules live in `packages/authz` (`reference.ts` is the plain-TypeScript reference, `sql.ts` the generated predicates, `write-tuples.ts` the only tuple writer). Any change must extend `fixture.ts` and keep `matrix.integration.ts` green; see ADR-0002 and ADR-0012 for the rule-change procedure.

## Database roles and SECURITY DEFINER functions

Migrations run as the owner/admin role (`DATABASE_ADMIN_URL`). That role must be a superuser or carry
`BYPASSRLS`: account, session, invite, notification and worker functions are `SECURITY DEFINER` and read
tenant tables that enforce `FORCE ROW LEVEL SECURITY`, so an owner without bypass would see no rows and
sign-in, invites and fan-out would silently return nothing. The schema lint fails when a tenant table is
owned by a role without bypass. Object storage must answer CORS preflights from the web origin for direct
multipart uploads; the API applies a bucket CORS rule at startup for `APP_BASE_URL` (override with
`S3_CORS_ORIGINS`). Presigned upload-part URLs are signed against `S3_PUBLIC_ENDPOINT` when set (the
browser-reachable address, for example the edge proxy's storage route; compose's internal `http://storage:8333`
is not resolvable by a browser), otherwise against `S3_ENDPOINT`. Emailed magic links and invites point at `APP_BASE_URL/magic?token=...`.

## Proxies and rate limits

`TRUST_PROXY` (default `false`) tells the API which upstream addresses may speak for the client via
`X-Forwarded-For` (Fastify `trustProxy` syntax). Use a CIDR list naming exactly the proxy that sets the
header from the connection, and nothing broader: not `true`, not `uniquelocal` (that would trust the Docker
gateway, i.e. anything on the host), not a hop count. Reverse proxies such as Caddy, nginx
(`$proxy_add_x_forwarded_for`), Traefik and Kubernetes ingress controllers set the header; the web app's
Next.js rewrites (`/api/*`, `/media/*` to the API) do not: they forward it exactly as received, so web
must never be a trusted hop. The compose stack therefore routes `/api` and `/media` at the Caddy edge
straight to the API and sets `TRUST_PROXY` to the edge's static address (`docs/deployment.md`, "Trust
chain"); the Helm chart does the same at the Ingress with `api.trustedProxyCidrs`. Running the API alone
(`pnpm --filter @our-stream/api dev`) keeps `TRUST_PROXY=false`.

Because of that, only unauthenticated traffic is budgeted by address. Everything else uses a key the
server validated itself (`apps/api/src/lib/limits.ts`), so neither a rotated cookie nor a spoofed
address buys a fresh budget:

| Budget (per minute)                     | Key                                     | Setting                          |
| --------------------------------------- | --------------------------------------- | -------------------------------- |
| sign-in routes                          | client address (`@fastify/rate-limit`)  | `AUTH_RATE_LIMIT_MAX` (20)       |
| signup, login, magic link               | normalised email the request acts on    | `AUTH_EMAIL_RATE_LIMIT_MAX` (10) |
| requests without a session              | client address                          | `IP_RATE_LIMIT_MAX` (600)        |
| authenticated requests                  | session id returned by the database     | `SESSION_RATE_LIMIT_MAX` (600)   |
| media served to a token                 | user id inside the verified media token | `MEDIA_RATE_LIMIT_MAX` (1200)    |
| likes, engagement, pins, tags, settings | session id                              | `WRITE_RATE_LIMIT_MAX` (60)      |
| comment creation                        | session id                              | `COMMENT_RATE_LIMIT_MAX` (10)    |
| keyword search                          | session id                              | `SEARCH_RATE_LIMIT_MAX` (60)     |
| share-as-link                           | session id                              | `SHARE_RATE_LIMIT_MAX` (20)      |

Budgets are in-memory per API process; a shared store is scheduled with multi-instance deployments
(ADR-0004), and until then every extra API replica multiplies the per-address budgets. When `TRUST_PROXY`
is `false` behind a proxy, the per-address budgets are shared by every user of that deployment and one
anonymous client can spend the sign-in budget for everyone. Fix that by trusting the proxy that sets the
header (as compose and the chart do), not by raising `AUTH_RATE_LIMIT_MAX` and `IP_RATE_LIMIT_MAX` or by
trusting a hop that forwards the header unchanged. The per-email budget protects accounts either way.
