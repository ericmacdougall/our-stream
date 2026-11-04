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
# web http://localhost:3000, api http://localhost:4000/health, mail http://localhost:8025, S3 http://localhost:8333
```

## Worker and media pipeline

`apps/worker` runs pg-boss under the platform role (`DATABASE_PLATFORM_URL`). It drains `platform.domain_event` every 5 s (`OUTBOX_DRAIN_INTERVAL_MS`) plus a once-a-minute cron, and reaches tenant rows only through the `platform_*` definer functions (migrations 0002/0003):

| event                                           | effect                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content.version_uploaded` (`version_id` set)   | enqueue `media.process` (singleton per version, 3 retries with backoff)                                                                                                            |
| `content.scheduled`, `content.expiry_scheduled` | read `publish_at`/`expires_at` from the database and enqueue `content.transition` jobs at those instants (payload times are ignored)                                               |
| `content.published`                             | one `content.published` notification per member in `platform_audience_of_content`, dedupe `published:{versionId}`                                                                  |
| `content.retracted`                             | one `content.retracted` notice per viewer of that version, dedupe `retracted:{versionId}`; title snapshot only with `org.settings.notify.include_title_after_access_loss = "true"` |

`media.process` downloads the original from S3 (`S3_*`, path style), probes it, transcodes an HLS fMP4 ladder (vertical-aware, never upscaled, 2 s GOP, 4 s segments, AAC 128k; audio-only rendition for audio uploads), renders a poster, a 10x10 sprite sheet with a WebVTT thumbnails track, runs ASR, writes WebVTT captions, uploads everything under `.../versions/{version}/derived/` and finally calls `platform_version_update(status 'current')`, which makes the version current. Failures persist `status = 'failed'` with a path-free `processing_error`. Limits: `FFMPEG_THREADS` (4), `FFMPEG_TIMEOUT_MS` (30 min), `FFPROBE_TIMEOUT_MS`, `MEDIA_MAX_INPUT_BYTES` (4 GiB), `WORKER_TMP_DIR`, `FFMPEG_PRESET` (`veryfast`), `MEDIA_CONCURRENCY` (1).

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
`S3_CORS_ORIGINS`). Emailed magic links and invites point at `APP_BASE_URL/magic?token=...`.

## Proxies and rate limits

`TRUST_PROXY` (default `false`) tells the API which upstream addresses may speak for the client via
`X-Forwarded-For` (Fastify `trustProxy` syntax: `false`, `true`, a CIDR list or `uniquelocal`). Enable
it only for hops that append their own peer to the header. Reverse proxies such as nginx
(`$proxy_add_x_forwarded_for`), Traefik and Kubernetes ingresses do; the web app's Next.js rewrites
(`/api/*`, `/media/*` to the API) do not: they forward the header exactly as the browser sent it. So
with the compose stack and no ingress, `TRUST_PROXY` stays `false` and every browser request reaches the
API from the web container's address. Behind an ingress that appends the peer, set `TRUST_PROXY` to
the ingress and compose network CIDRs so `req.ip` is the real client.

Because of that, only unauthenticated traffic is budgeted by address. Everything else uses a key the
server validated itself (`apps/api/src/lib/limits.ts`), so neither a rotated cookie nor a spoofed
address buys a fresh budget:

| Budget (per minute)         | Key                                      | Setting                     |
| --------------------------- | ---------------------------------------- | --------------------------- |
| sign-in routes              | client address (`@fastify/rate-limit`)   | `AUTH_RATE_LIMIT_MAX` (20)  |
| signup, login, magic link   | normalised email the request acts on     | `AUTH_EMAIL_RATE_LIMIT_MAX` (10) |
| requests without a session  | client address                           | `IP_RATE_LIMIT_MAX` (600)   |
| authenticated requests      | session id returned by the database      | `SESSION_RATE_LIMIT_MAX` (600) |
| media served to a token     | user id inside the verified media token  | `MEDIA_RATE_LIMIT_MAX` (1200) |

Budgets are in-memory per API process; a shared store is scheduled with multi-instance deployments
(ADR-0004). When `TRUST_PROXY` is `false` behind the web container, the per-address budgets are shared
by every browser user of that deployment, so raise `AUTH_RATE_LIMIT_MAX` and `IP_RATE_LIMIT_MAX` for
larger single-host installs rather than enabling `TRUST_PROXY` for a hop that does not append its peer.
