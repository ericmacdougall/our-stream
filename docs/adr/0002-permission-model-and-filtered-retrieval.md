# ADR-0002: Permission model and permission-filtered retrieval

Status: proposed v2, 2026-11-03 (revised after plan review round 1: findings F1-F4, F10); amended 2026-11-04 for the M2a document gate. Confidence: high.

## Context

Users must only ever see, search, retrieve or be answered from content they are allowed to see. The permission decision must be deterministic, auditable, fast enough to sit inside a vector query over hundreds of thousands of chunks, and simple to self-host. Models never decide authorization. Integrations (SharePoint, Copilot) need the same model expressed as ACLs. Research (2026-11-03) shows external ReBAC engines (OpenFGA, SpiceDB) cap or discourage large list operations and cannot be pushed into a pgvector `WHERE`; Postgres-native ACLs can.

## Decision

### Model: relationship tuples in Postgres

Authorization is stored as tuples `(org_id, object_type, object_id, relation, subject_type, subject_id)` in `relation_tuple`, shaped like OpenFGA/Zanzibar tuples so a later migration to an external engine would be mechanical.

| object  | relations                                    | subjects                                                                              |
| ------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| org     | owner, admin, announcer, contributor, member | user                                                                                  |
| group   | member                                       | user, group (nesting depth ≤ 4, cycles rejected at write time by walking the closure) |
| stream  | owner, moderator, contributor, viewer        | user, group, `org#member` (everyone)                                                  |
| content | owner, editor, viewer (direct grants)        | user, group                                                                           |

Audience is expressed as tuples: publishing content "to stream S" writes `(content, C, viewer, stream, S#viewer)`; "to everyone" writes `(content, C, viewer, org, O#member)`; "to group G" writes `(content, C, viewer, group, G#member)`; "to user U" writes `(content, C, viewer, user, U)`.

### Two named predicates, never mixed

1. **`readerVisible(user, content)`** is the only predicate used by the feed, search (results, counts, facets, snippets, autocomplete), vector retrieval, media delivery, notifications, exports, citations, viewer lists, pinned-item counts, mention autocomplete and SSE broadcasts. True iff all of:
   - `content.org_id = :org` **and** `:user` has an active org membership in `:org` (`EXISTS` on `org_membership` with `status = 'active'`).
   - `content.state = 'published'` and `publish_at <= now()` and (`expires_at is null or expires_at > now()`) and `retracted_at is null`, evaluated against the current version.
   - An audience path exists: direct user tuple; a group the user is a (transitive) member of; a stream the user can view (directly, via group, or via `org#member`); or `org#member`.
     Drafts, not-yet-published (future `publish_at`), expired and retracted items are **never** reader-visible to anyone, including their owner. The stored `state` enum is `draft | published | retracted`; "scheduled" and "expired" are derived from the timestamps, never stored, so visibility never depends on a job. Publishing always sets `publish_at` (now or the scheduled instant); `publish_at` is `NOT NULL` for published rows, so a missing value fails closed.
2. **`authorAccessible(user, content)`** is used only by editing, moderation, publishing, processing-status and version-history endpoints. It requires `content.org_id = :org` and an active membership of `:user` in `:org` (stated explicitly so the predicate holds with RLS deliberately off in tests). Then:
   - Drafts are accessible only to the owner, editors and org admins/owners until the author requests review; after a review request, moderators and owners of the streams in the draft's audience can access it.
   - Published items (whether not yet live, live, or expired by timestamp) and retracted items are accessible to the owner, editors, org admins/owners, and moderators/owners of streams in the audience; moderators see the audience entries for their own stream only, and private principals (direct users, private groups) and old versions are hidden from them and stay on the audited auditor path.
   - An admin opening a draft or an item addressed to private principals is an audit event.
3. **Admin and auditor access** to old versions and retracted content is a third, explicitly logged path (`auditorAccessible`): org owners, admins and users holding the `auditor` org role; every access is an audit event. It is never used by reader paths.

### Writing tuples (publish and share rules)

- Publishing to stream S requires `contributor` (or higher) on S. Publishing to `org#member` requires the `announcer`, `admin` or `owner` org role. Publishing to a group requires membership of that group or `admin`. Publishing to a user requires that the target is an active member; private-stream content cannot be re-targeted outside the stream by non-moderators.
- **Sharing never writes tuples.** "Share to a stream or person" creates a notification or link only; the recipient sees the item iff they already pass `readerVisible`. Otherwise they get a neutral "this item is not available to you" message that carries no title, owner identity or stream name; the sharer (not the recipient) is told the recipient lacks access and can ask the owner to widen the audience through the publish rules.
- Retracted and expired items cannot be shared.
- Direct grants (`content#viewer` to a user) are made only by the owner, editors or admins.
- Every tuple write is validated against these rules in one function (`authz.writeTuples`) that is the only writer; tests cover each rule positively and negatively.

### Materialisation and consistency

- `user_group_membership(org_id, user_id, group_id)` closure table and `user_stream_access(org_id, user_id, stream_id, role)` are **real tables** (not Postgres materialised views, which cannot carry RLS) with `org_id` and RLS.
- **Revocations are synchronous and trigger-driven**: removing a user from a group, a nested group from its parent group, a group from a stream, a stream role, a direct grant, deactivating a user, or shrinking an audience fires row triggers (ADR-0001 §1b) that delete the affected closure and access rows and bump affected users' `authz_epoch` in the same transaction as the change. The maximum leak window after a revocation commit is therefore zero requests. A 10k-member group removal is a bounded set-based delete; its cost is accepted for correctness and tested.
- **Grants are inserted by the reconciliation job** (`authz.reconcile`, enqueued by the same triggers) because a delayed grant is availability, not a leak; small grants (a single user added to a stream) are also applied inline by the trigger for responsiveness. The job additionally runs a periodic full reconcile that must find zero differences (alerting metric). Division of labour: triggers delete synchronously and may insert small grants; the job inserts bulk grants and reconciles.
- Group depth ≤ 4 and cycle rejection are enforced in `authz.writeTuples` before insert.

### Amendment (M2a, 2026-11-04): the document gate

Documents (`content.kind = 'document'`) add one clause to `readerVisible`, in the generated SQL, in the independent reference implementation and in every hand copy of the rule:

```sql
(c.kind <> 'document'
 OR ((SELECT platform_documents_enabled(:org))
     AND EXISTS (SELECT 1 FROM content_version cv
                 WHERE cv.org_id = c.org_id AND cv.id = c.current_version_id AND cv.status = 'current')))
```

- `platform_documents_enabled(org)` (a STABLE definer function on the app allow-list that asserts `org = app_org()`) combines the deployment kill switch (`platform.documents_kill_switch`) with the org flag `org.settings.documents_enabled`. An absent or non-true key is off, so the gate fails closed. It is uncorrelated with the row, so the planner evaluates it once per query as an InitPlan.
- A document whose current version is `processing`, `failed`, missing or retracted is invisible to everyone, owner included (owners manage it through `authorAccessible`, which is unchanged). Clips and audio never reach the new branch.
- Hand copies of the rule that never call `readerVisibleSql` (`platform_audience_of_content`, `platform_digest_items`; `platform_viewers_of_version` for the same document condition) carry the same clause, calling `documents_enabled_unchecked(org)` because the worker has no tenant context. A test enumerates the latest definition of every function in `packages/db/migrations/*.sql` that contains a predicate key and every TypeScript caller of `readerVisibleSql`; it fails when a new copy appears.
- Flag and kill switch changes advance the org content epoch (`org_epoch_advance`), so cached permitted-id sets are never used across a flag change. Cached id sets only narrow candidates; every returned chunk is re-checked by the full predicate inside the request snapshot.
- Retraction and expiry are unchanged and still apply to documents; the flag only adds a way to make documents unreachable without retracting them (retraction is terminal, the flag is reversible).

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
4. Chunks join `content_version.status = 'current'` so retracted or superseded versions are never used even if an index lags. For documents the chunks are written in the same transaction that makes the version current (`platform_document_finish`), never by the transcript indexer.

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

- Fixture matrix: 2 orgs × users (owner, admin, announcer, contributor, member, non-member, deactivated, auditor) × groups (nested to depth 4, a rejected cycle) × streams (company, department, private) × content states (draft; published with future, current and past `publish_at`/`expires_at` combinations; retracted) × audience kinds × a draft with mixed private audience. Expected `readerVisible`, `authorAccessible` and `auditorAccessible` are computed by an independent TypeScript reference implementation; the SQL predicates, feed, search (including counts, facets, autocomplete), retrieval, media and notification recipients must agree on every cell. A draft is never returned by any reader path for anyone.
- Retrieval subset property: for random queries over seeded chunks (present from M0), every returned chunk satisfies `readerVisible`.
- Negative: cross-org; deactivated user with a live session, refresh token and media token (next request to feed, media and `/sync` fails); expired; retracted; scheduled-in-future; 10k-member group removal hides content on the next request; nested group removed from its parent; stream role downgrade; direct grant revoked; share to a non-viewer reveals nothing; contributor publishing to a stream they lack rights on; non-announcer publishing org-wide; duplicate-upload oracle across users.
