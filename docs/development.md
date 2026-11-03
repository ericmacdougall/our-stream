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
pnpm test:integration  # needs DATABASE_ADMIN_URL and DATABASE_URL (RLS-bound app role)
pnpm headers:check && pnpm licenses:check
pnpm contracts:generate   # emit OpenAPI from the API and regenerate typed client types
```

## Database roles

Migrations run as the owner/admin role (`DATABASE_ADMIN_URL`). The API and tenant jobs connect as `ourstream_app` (`DATABASE_URL`), which has no `BYPASSRLS` and owns nothing; every tenant query runs inside `withTenant()` which sets `app.org_id`/`app.user_id` with `SET LOCAL`. The worker's platform jobs connect as `ourstream_platform` (`DATABASE_PLATFORM_URL`) for pg-boss and the outbox. `infra/docker/postgres/init/01-roles.sql` creates the dev roles; CI creates them inline.

## Compose

```sh
docker compose -f infra/docker/docker-compose.yml up --build
# web http://localhost:3000, api http://localhost:4000/health, mail http://localhost:8025, S3 http://localhost:8333
```

## Permission rules

The authorization rules live in `packages/authz` (`reference.ts` is the plain-TypeScript reference, `sql.ts` the generated predicates, `write-tuples.ts` the only tuple writer). Any change must extend `fixture.ts` and keep `matrix.integration.ts` green; see ADR-0002 and ADR-0012 for the rule-change procedure.
