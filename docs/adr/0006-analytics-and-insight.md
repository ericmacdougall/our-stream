# ADR-0006: Analytics, engagement tracking and the team dashboard

Status: proposed, 2026-11-03. Confidence: high on event model, medium on clustering approach.

## Context

Contributors need to know who saw, watched, rewatched, commented or acknowledged; teams need to see what people ask, how often, what stays unresolved, and what new material would help. Viewing data is personal data: orgs differ on whether managers may see named viewers.

## Decision

1. **Event model.** Append-only `engagement_event(org_id, user_id, content_id, content_version_id, type, at, session_id, position_ms, meta)` partitioned monthly. Types: `impression`, `view_start`, `progress` (25/50/75/100 percent milestones), `complete`, `rewatch`, `like`, `unlike`, `comment`, `share`, `ack`, `link_click`, `chapter_jump`, `search`, `question_asked`, `answer_feedback`. Clients batch heartbeats; milestones are idempotent per (user, version, milestone).
2. **Derived state.** `user_content_state(org, user, content)`: first and last view, last position, max progress, watch count, acknowledged version. Updated transactionally from `view_start`, `complete`, `ack` (needed for targeting, ADR-0005); other fields updated by the rollup job.
3. **Rollups.** Hourly job builds `content_stats_hourly` and `content_stats` (unique viewers, completions, average watched percent, rewatches, likes, comments, acks, by stream and by department); dashboards read rollups only.
4. **Question analytics.** Every question is logged with retrieved chunk ids, answer, model, confidence (retrieval score band plus self-reported), feedback (thumbs), and `resolution`: `answered`, `answered_low_confidence`, `no_answer`, `escalated`. A nightly job clusters questions per org (embedding similarity with a deterministic threshold and canonical representative) to produce `question_cluster` with counts, trend and resolution rates. The dashboard shows top clusters, unresolved clusters, and which content answers them.
5. **AI suggestions.** A batch job takes unresolved and low-confidence clusters, the content inventory of the relevant streams, and produces suggestions ("record a 60 s clip on X; people ask it 14 times a month; the closest existing clip is Y but it does not cover Z"). Suggestions are labelled AI-generated, link to the evidence (clusters, questions), and can be accepted into a content brief or dismissed; feedback is logged. The job runs under the org's model policy (ADR-0008) and never includes content the dashboard viewer cannot see.
6. **Privacy modes** per org: `identified` (named viewer lists for contributors and managers), `aggregate_only` (counts and percentages only; acknowledgements remain identified because they are attestations), `identified_for_required_only` (default: named for content marked required/ack, aggregate otherwise). Viewers see what is visible to others in their settings page. Raw events have a retention period (default 13 months) separate from rollups.
7. **Export.** CSV/JSON export of rollups and (if permitted) viewer lists, audited.

## Consequences

- Transactional writes are limited to the few events that drive targeting; heartbeats are cheap batched inserts.
- Clustering is deterministic given the embedding model and threshold; a model change triggers re-clustering.
- Privacy defaults are conservative and explicit.

## Tests

- Milestone idempotency under duplicate heartbeats and out-of-order delivery.
- Rollup equals a brute-force computation on a seeded event set.
- Privacy mode `aggregate_only` leaks no user ids through any dashboard endpoint (snapshot assertion on response shapes).
- Cluster stability: same input twice yields identical clusters.
