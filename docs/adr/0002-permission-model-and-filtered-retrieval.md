# ADR-0002: Permission model and permission-filtered retrieval

Status: proposed, 2026-11-03. Confidence: high.

## Context

Users must only ever see, search, retrieve or be answered from content they are allowed to see. The permission decision must be deterministic, auditable, fast enough to sit inside a vector query over hundreds of thousands of chunks, and simple to self-host. Models never decide authorization (prompt injection or hallucination must not widen access). Integrations (SharePoint, Copilot) need the same model expressed as ACLs. Research (2026-11-03) shows external ReBAC engines (OpenFGA, SpiceDB) cap or discourage large list operations and cannot be pushed into a pgvector `WHERE`; Postgres-native ACLs can.

## Decision

### Model: relationship tuples in Postgres

Store authorization as tuples `(org_id, object_type, object_id, relation, subject_type, subject_id)` in table `relation_tuple`, shaped like OpenFGA/Zanzibar tuples so a later migration to an external engine would be mechanical. Object types and relations in v1:

| object | relations | subjects |
|---|---|---|
| org | owner, admin, contributor, member | user |
| group | member | user, group (nesting bounded to depth 4) |
| stream | owner, moderator, contributor, viewer | user, group, `org#member` (everyone) |
| content | owner, editor, viewer (direct grants) | user, group |

Audience is expressed as tuples too: publishing content "to stream S" writes `(content, C, viewer, stream, S#viewer)`; "to everyone" writes `(content, C, viewer, org, O#member)`; "to group G" writes `(content, C, viewer, group, G#member)`.

### Rules (fixed, in code and SQL, not configurable by end users)

`canView(user, content)` is true iff all of:
1. `content.org_id = user.org_id` and the user is an active org member.
2. `content.state = 'published'` and `publish_at <= now()` and (`expires_at is null or expires_at > now()`) and `retracted_at is null`, **or** the user is the content owner, an editor, or a stream moderator/owner of a stream in the audience (drafts and scheduled items are visible to their authors and moderators).
3. There exists an audience path: direct user tuple; a group the user is a (transitive) member of; a stream the user can view (directly, via group, or via `org#member` for company-wide streams); or `org#member`.

Edit, moderate and publish follow analogous rules documented in `packages/authz/RULES.md`.

### Materialisation for speed

- `user_group_membership(org_id, user_id, group_id)` closure table maintained on group changes (bounded nesting).
- `user_stream_access(org_id, user_id, stream_id, role)` materialised view-table maintained by triggers and a reconciliation job; sized users × streams-they-can-see, which is small.
- `content_audience(org_id, content_id, kind, principal_id)` denormalised from tuples for the content object type.
- Visibility predicate for lists, feed, search and retrieval (parameterised by user):

```sql
c.org_id = :org
AND c.state = 'published' AND c.publish_at <= now() AND (c.expires_at IS NULL OR c.expires_at > now()) AND c.retracted_at IS NULL
AND EXISTS (
  SELECT 1 FROM content_audience a
  WHERE a.org_id = c.org_id AND a.content_id = c.id AND (
       (a.kind = 'org')
    OR (a.kind = 'user'   AND a.principal_id = :user)
    OR (a.kind = 'group'  AND a.principal_id IN (SELECT group_id  FROM user_group_membership WHERE org_id = :org AND user_id = :user))
    OR (a.kind = 'stream' AND a.principal_id IN (SELECT stream_id FROM user_stream_access     WHERE org_id = :org AND user_id = :user))
  ))
```

The same predicate (generated once in `packages/authz/sql.ts`) is used by the feed, keyword search, vector search and the citation validator. `canView` for a single item is the same predicate with `c.id = :content`.

### Retrieval

1. Compute the user's `permitted_content_version_ids` for the org when the permitted set is small (below a threshold, typically < 5,000) and cache it keyed by `(org, user, authz_epoch)`; query chunks with `content_version_id = ANY(:ids)`.
2. Otherwise run the vector query with the predicate in `WHERE` and `hnsw.iterative_scan = relaxed_order`, over-fetching k×4 then re-ranking.
3. Post-check: before any chunk reaches the model, assert `canView` again for every chunk in the same transaction; a violation throws, is logged as `authz.leak_check_failed` and increments a metric that must stay at zero.
4. Chunks also check `content_version.status = 'current'` so retracted or superseded versions are never used even if an index lags.

### Integrations

- SharePoint items are imported with a `source_acl` expanded into our principals (mapped Entra users and groups); unresolvable principals mean the item gets **no** audience tuple (fail closed) and is reported to the admin.
- Copilot connector export emits `acl` from `content_audience` using mapped Entra ids and `externalGroup` for local groups; content with unmappable audiences is not exported.

## Consequences

- No extra service; one SQL round trip; deterministic and unit-testable.
- Fan-out on large group or stream changes is a bounded reconciliation job (`authz.reconcile`) that also bumps affected users' `authz_epoch` (ADR-0004).
- Rule changes require a migration and a test-matrix update; they are not end-user configurable, which keeps the model auditable.
- OpenFGA-shaped tuples keep the exit door open.

## Alternatives

- OpenFGA or SpiceDB: richer semantics, but list operations are capped (1,000 / ~10k) and cannot be pushed into pgvector; adds a service to self-host. Rejected for v1; migration path preserved.
- Cerbos: good for policy decisions on API calls; does not own the relationship graph. Optional later.
- Letting the model see everything and filtering citations: rejected absolutely.

## Tests (contract and red-team)

- Fixture matrix: 2 orgs × users (owner, admin, member, non-member, deactivated) × groups (nested) × streams (company, department, private) × content states (draft, scheduled, published, expired, retracted) × audience kinds. Expected visibility is computed by an independent reference implementation in plain TypeScript; the SQL predicate, `canView`, the feed, search and retrieval must agree on every cell.
- Retrieval subset property: for random queries, every returned chunk satisfies `canView` (property-based, seeded).
- Negative: cross-org, deactivated user, expired, retracted, scheduled-in-future, group removal propagation within one reconcile, stream role downgrade, direct grant revoked.
