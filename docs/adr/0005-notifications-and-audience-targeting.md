# ADR-0005: Notification fan-out and audience targeting

Status: proposed, 2026-11-03. Confidence: high on design, medium on channel specifics (Teams app details in M6).

## Context

Publishing, pinning, retracting or replacing content must reach the right people on the right channel, including the specific people who saw or asked about an outdated version. Fan-out must be reliable (no lost retraction alerts), deduplicated, rate-limited and respectful of user preferences and quiet hours.

## Decision

1. **Transactional outbox.** Every domain change writes a `domain_event` row (org, type, subject ids, version, actor, payload) in the same transaction. A pg-boss job drains the outbox; events are processed at least once with idempotency keys.
2. **Targeting rules** resolve an event to recipient sets, each with a `reason` code:
   - `audience`: users who can view the content now (visibility predicate, ADR-0002).
   - `saw_version`: users with a `view` or `ack` event on a specific version (from `user_content_state`).
   - `asked_related`: users whose logged questions had an answer citing that content version.
   - `pinned_for`: audience of a pinned announcement.
   - `commented`, `mentioned`, `moderation`.
   Recipient resolution respects permissions at delivery time: a retraction notice goes to `saw_version` users even if they lost access (they need to know the old version is wrong), but the notice contains no content from the retracted item beyond its title; a "new version available" link only resolves if they still have access.
3. **Notification record** per (user, event key) with `dedupe_key = sha256(org, user, type, subject, version)`; duplicates are dropped. Each record tracks channel deliveries and states (queued, sent, failed, read).
4. **Channels** as adapters: in-app (always), email (SMTP or provider adapter), Teams bot proactive message (M6), Expo push (M10), webhook (generic, M3). Channel selection = org policy ∩ user preference ∩ event severity. `retraction` and `pinned_announcement` are "important" and bypass digests but not quiet hours unless the org marks them critical.
5. **Digests.** Non-important events batch per user per channel on a schedule (default hourly in-app badge, daily email). Important events send immediately with rate limiting per user (max N per minute) and collapsing (one message listing several items).
6. **Content of notifications is permission-checked at render time**, not at enqueue time: a notification pointing at content the user can no longer see renders as a neutral "an item you followed is no longer available" message.
7. **Preferences and compliance**: per-user channel and digest settings; org-level overrides for compliance notices; unsubscribe for email per category except mandatory compliance notices; everything audited.

## Consequences

- Reliable and deduplicated by construction; the outbox table doubles as an audit trail for fan-out.
- Targeting by `saw_version` and `asked_related` requires analytics events (ADR-0006) to be transactional for views and question logs; heartbeats remain best-effort.
- Email and Teams adapters are the only parts with external failure modes; retries with backoff and a dead-letter queue visible to admins.

## Tests

- Publish to a stream with nested groups: recipients equal the visibility predicate result (same fixture matrix as ADR-0002).
- Retract after views: users who viewed v1 receive one retraction notice each, non-viewers in the audience receive the standard removal notice only if the org enables it, duplicates suppressed on replay of the outbox.
- Lost access before delivery: rendered notification contains no content.
- Rate limit and digest timing with a fake clock.
