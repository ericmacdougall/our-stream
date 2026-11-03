# ADR-0002: Permission model and permission-filtered retrieval

Status: proposed v2, 2026-11-03 (revised after plan review round 1: findings F1-F4, F10). Confidence: high.

## Context

Users must only ever see, search, retrieve or be answered from content they are allowed to see. The permission decision must be deterministic, auditable, fast enough to sit inside a vector query over hundreds of thousands of chunks, and simple to self-host. Models never decide authorization. Integrations (SharePoint, Copilot) need the same model expressed as ACLs. Research (2026-11-03) shows external ReBAC engines (OpenFGA, SpiceDB) cap or discourage large list operations and cannot be pushed into a pgvector `WHERE`; Postgres-native ACLs can.

## Decision

### Model: relationship tuples in Postgres

Authorization is stored as tuples `(org_id, object_type, object_id, relation, subject_type, subject_id)` in `relation_tuple`, shaped like OpenFGA/Zanzibar tuples so a later migration to an external engine would be mechanical.

| object | relations | subjects |
|---|---|---|
| org | owner, admin, announcer, contributor, member | user |
| group | member | user, group (nesting depth ≤ 4, cycles rejected at write time by walking the closure) |
| stream | owner, moderator, contributor, viewer | user, group, `org#member` (everyone) |
| content | owner, editor, viewer (direct grants) | user, group |

Audience is expressed as tuples: publishing content "to stream S" writes `(content, C, viewer, stream, S#viewer)`; "to everyone" writes `(content, C, viewer, org, O#member)`; "to group G" writes `(content, C, viewer, group, G#member)`; "to user U" writes `(content, C, viewer, user, U)`.

### Two named predicates, never mixed

1. **`readerVisible(user, content)`** is the only predicate used by the feed, search (results, counts, facets, snippets, autocomplete), vector retrieval, media delivery, notifications, exports, citations, viewer lists, pinned-item counts, mention autocomplete and SSE broadcasts. True iff all of:
   - `content.org_id = :org` **and** `:user` has an active org membership in `:org` (`EXISTS` on `org_membership` with `status = 'active'`).
   - `content.state = 'published'` and `publish_at <= now()` and (`expires_at is null or expires_at > now()`) and `retracted_at is null`, evaluated against the current version.
   - An audience path exists: direct user tuple; a group the user is a (transitive) member of; a stream the user can view (directly, via group, or via `org#member`); or `org#member`.
   Drafts, scheduled, expired and retracted items are **never** reader-visible to anyone, including their owner.
2. **`authorAccessible(user, content)`** is used only by editing, moderation, publishing, processing-status and version-history endpoints. True iff the user is active and is the content owner, an editor, an org admin/owner, or a moderator/owner of a stream in the audience **and** the content's audience contains no private principal (direct user or private group) outside that stream; a draft that targets stream S plus a private group is accessible to S's moderators only after the author explicitly requests review. Adding a stream to a draft's audience does not expose it to that stream's moderators until review is requested.
3. **Admin and auditor access** to old versions and retracted content is a third, explicitly logged path (`auditorAccessible`): org owners, admins and users holding the `auditor` org role; every access is an audit event. It is never used by reader paths.

### Writing tuples (publish and share rules)

- Publishing to stream S requires `contributor` (or higher) on S. Publishing to `org#member` requires the `announcer`, `admin` or `owner` org role. Publishing to a group requires membership of that group or `admin`. Publishing to a user requires that the target is an active member; private-stream content cannot be re-targeted outside the stream by non-moderators.
- **Sharing never writes tuples.** "Share to a stream or person" creates a notification or link only; the recipient sees the item iff they already pass `readerVisible`. Otherwise they get a neutral "you do not have access; ask the owner" message, and the owner can be asked to widen the audience through the publish rules.
- Retracted and expired items cannot be shared.
- Direct grants (`content#viewer` to a user) are made only by the owner, editors or admins.
- Every tuple write is validated against these rules in one function (`authz.writeTuples`) that is the only writer; tests cover each rule positively and negatively.

### Materialisation and consistency

- `user_group_membership(org_id, user_id, group_id)` closure table and `user_stream_access(org_id, user_id, stream_id, role)` are **real tables** (not Postgres materialised views, which cannot carry RLS) with `org_id` and RLS.
- **Revocations are synchronous**: removing a user from a group, a group from a stream, a stream role, a direct grant, deactivating a user, or shrinking an audience deletes the affected closure and access rows and bumps affected users' `authz_epoch` in the same transaction as the change. The maximum leak window after a revocation commit is therefore zero requests. A 10k-member group removal is a bounded set-based delete; its cost is accepted for correctness and tested.
- **Grants may be asynchronous** (a reconciliation job) because a delayed grant is availability, not a leak; the job also runs a periodic full reconcile that must find zero differences (alerting metric).
- Group depth ≤ 4 and cycle rejection are enforced in `authz.writeTuples` before insert.

### Generated SQL predicate

`packages/authz/sql.ts` generates `readerVisible` once, parameterised by `(:org, :user)`:

```sql
EXISTS (SELECT 1 FROM org_membership m WHERE m.org_id = :org AND m.user_id = :user AND m.status = 'active')
AND c.org_id = :org
AND c.state = 'published' AND c.publish_at <= now() AND (c.expires_at IS NULL OR c.expires_at > now()) AND c.retracted_at IS NULL
AND EXISTS (
  SELECT 1 FROM content_audience a
  WHERE a.org_id = c.org_id AND a.content_id = c.id AND (
       a.kind = 'org'
    OR (a.kind = 'user'   AND a.principal_id = :user)
    OR (a.kind = 'group'  AND a.principal_id IN (SELECT group_id  FROM user_group_membership WHERE org_id = :org AND user_id = :user))
    OR (a.kind = 'stream' AND a.principal_id IN (SELECT stream_id FROM user_stream_access     WHERE org_id = :org AND user_id = :user))
  ))
```

`content_audience` is denormalised from `relation_tuple` rows for content objects in the same transaction. Single-item `readerVisible` is the same predicate with `c.id = :content`. `authz_epoch` and membership status are read from the database on every request; they are never carried in a JWT or session cookie. Sessions and refresh tokens are revoked on deactivation.

### Retrieval

1. If the user's permitted current-version set is small (below a configured threshold, default 5,000), compute it, cache it keyed by `(org, user, authz_epoch, org_content_epoch, time_bucket)` (ADR-0004) and query chunks with `content_version_id = ANY(:ids)`.
2. Otherwise run the vector query with the predicate in `WHERE`, `hnsw.iterative_scan = relaxed_order`, over-fetching k×4 and re-ranking. If fewer than k rows return and `hnsw.max_scan_tuples` was hit, fall back to an exact scan over the permitted set (recall test in CI, F14).
3. Post-check: before any chunk reaches the model, assert `readerVisible` for every chunk in the same transaction; a violation throws, logs `authz.leak_check_failed` and increments a metric that must stay at zero.
4. Chunks join `content_version.status = 'current'` so retracted or superseded versions are never used even if an index lags.

### Side channels

Everything that reveals existence or metadata goes through `readerVisible`: duplicate-upload detection is scoped to the uploader's own content; search counts, facets, snippets and autocomplete are computed over the filtered set; mention autocomplete lists only users who share at least one reader-visible stream with the viewer; comment-mention notifications are dropped if the mentioned user fails `readerVisible` for the item; viewer lists follow the org privacy mode and `readerVisible`; SSE `content.*` events are delivered per user after the predicate; pinned-item counts are per user.

### Integrations

- SharePoint items are imported with a `source_acl` expanded into our principals; unresolvable principals mean the item gets no audience tuple (fail closed) and the admin is told.
- Copilot connector export emits `acl` from `content_audience` using mapped Entra ids and `externalGroup` for local groups; content with unmappable audiences is not exported.

## Consequences

- No extra service; one SQL round trip; deterministic and unit-testable.
- Revocation cost is paid synchronously; grant fan-out is a job.
- Rule changes require a migration, a reference-implementation update and the shadow-compare procedure in ADR-0012; rules are not end-user configurable.

## Alternatives

- OpenFGA or SpiceDB: rejected for v1 (list caps, not pushable into pgvector, extra service); tuple shape preserves migration.
- Cerbos for API policy decisions: optional later.
- Letting the model see everything and filtering citations: rejected absolutely.

## Tests (contract and red-team)

- Fixture matrix: 2 orgs × users (owner, admin, announcer, contributor, member, non-member, deactivated, auditor) × groups (nested to depth 4, a rejected cycle) × streams (company, department, private) × content states (draft, scheduled, published, expired, retracted) × audience kinds × a draft with mixed private audience. Expected `readerVisible`, `authorAccessible` and `auditorAccessible` are computed by an independent TypeScript reference implementation; the SQL predicates, feed, search (including counts, facets, autocomplete), retrieval, media and notification recipients must agree on every cell. A draft is never returned by any reader path for anyone.
- Retrieval subset property: for random queries over seeded chunks (present from M0), every returned chunk satisfies `readerVisible`.
- Negative: cross-org; deactivated user with a live session, refresh token and media token (next request to feed, media and `/sync` fails); expired; retracted; scheduled-in-future; 10k-member group removal hides content on the next request; stream role downgrade; direct grant revoked; share to a non-viewer reveals nothing; contributor publishing to a stream they lack rights on; non-announcer publishing org-wide; duplicate-upload oracle across users.
