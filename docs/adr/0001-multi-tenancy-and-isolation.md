# ADR-0001: Multi-tenancy and isolation

Status: proposed, 2026-11-03. Confidence: high on mechanism, medium on hosted-cell sizing.

## Context

our-stream runs as a self-hosted single-org install, a self-hosted multi-org install (a holding company), or a hosted SaaS with thousands of orgs. Customer data must never cross org boundaries in the database, object storage, caches, queues, model calls, search indexes or integration exports. Enterprise buyers also ask for data residency (region pinning) and, sometimes, physical isolation.

## Decision

1. **Shared Postgres, row-level tenancy, enforced by RLS.** Every tenant-owned table carries `org_id uuid not null` as the first column of its primary or unique indexes. The API opens a transaction per request and runs `SET LOCAL app.org_id = $1; SET LOCAL app.user_id = $2`. Policies use `FORCE ROW LEVEL SECURITY` on every tenant table and compare `org_id = current_setting('app.org_id')::uuid`. The application database role is not the table owner, has no `BYPASSRLS`, and cannot alter policies. Migrations run under a separate role.
2. **Composite foreign keys carry `org_id`** (for example `content(org_id, id)` referenced by `audience(org_id, content_id)`), so a bug cannot link rows across orgs even before RLS is considered, and unique/FK covert channels (which bypass RLS) cannot reveal other tenants' keys.
3. **Object storage is prefixed per org** (`orgs/{org_id}/...`) in a bucket per region. Keys are opaque UUIDs. No public buckets. All reads go through signed URLs or an authenticated proxy (ADR-0003, ADR-0004). Hosted SaaS uses one bucket per region cell; self-host uses one bucket.
4. **Queue jobs carry `org_id`** in their payload and the worker re-establishes the tenant context before any query. Jobs never process more than one org.
5. **Caches, search and vector indexes are keyed by `org_id`.** Epoch-keyed cache keys (ADR-0004) include the org id. Partial HNSW indexes per large org are an optimisation that also bounds scans to one tenant.
6. **Model calls and integration exports are scoped per org** with that org's provider policy (ADR-0008) and credentials; no shared embeddings cache across orgs.
7. **Region pinning.** An org has `region` set at creation. Hosted SaaS runs independent cells (Postgres, storage, workers) per region; the control plane stores only org → region routing and billing. Customer content never replicates across regions. Self-host is implicitly one region.
8. **Dedicated-database option.** The schema and code never assume shared tables, so an org can be moved to a dedicated Postgres instance (and bucket) with the same code via connection routing. Offered as an enterprise tier of the hosted service; not built in v1 beyond keeping the code path free of cross-org queries.
9. **Platform-level tables** (hosted billing, cell registry, feature flags) live in a separate schema with no RLS exposure to the tenant role.

## Consequences

- Every query must run inside the tenant context; a request-scoped `db` helper enforces this, and a test asserts that no tenant table lacks a policy (schema lint).
- Cross-org admin tooling (support console) uses a separate, audited role and never the API role.
- Performance: RLS predicates are cheap equality checks on indexed `org_id`; non-leakproof functions in policies are avoided.
- Backups and restores are per cell; per-org export (DSR, offboarding) is a worker job writing a signed archive.

## Alternatives considered

- Schema-per-tenant: migration fan-out and connection pooling costs grow with tenants; rejected for v1, kept possible via the dedicated-database path.
- Database-per-tenant by default: too heavy for small teams and compose installs.

## Tests

- Fixture with two orgs sharing user emails and identical content; every list, feed, search, retrieval, media and notification path asserts zero cross-org rows with RLS on and with RLS deliberately bypassed (to prove application filters alone also hold).
- Schema lint: every table in the tenant schema has `org_id`, `FORCE ROW LEVEL SECURITY` and a policy.
