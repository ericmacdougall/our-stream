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

## Database roles

Migrations run as the owner/admin role (`DATABASE_ADMIN_URL`). The API and tenant jobs connect as `ourstream_app` (`DATABASE_URL`), which has no `BYPASSRLS` and owns nothing; every tenant query runs inside `withTenant()` which sets `app.org_id`/`app.user_id` with `SET LOCAL`. The worker's platform jobs connect as `ourstream_platform` (`DATABASE_PLATFORM_URL`) for pg-boss and the outbox. `infra/docker/postgres/init/01-roles.sql` creates the dev roles; CI creates them inline.

## Compose

```sh
docker compose -f infra/docker/docker-compose.yml up --build
# web http://localhost:3000, api http://localhost:4000/health, mail http://localhost:8025, S3 http://localhost:8333
```

## Permission rules

The authorization rules live in `packages/authz` (`reference.ts` is the plain-TypeScript reference, `sql.ts` the generated predicates, `write-tuples.ts` the only tuple writer). Any change must extend `fixture.ts` and keep `matrix.integration.ts` green; see ADR-0002 and ADR-0012 for the rule-change procedure.
