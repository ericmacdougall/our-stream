# ADR-0005: Notification fan-out and audience targeting

Status: proposed, 2026-11-03. Confidence: high on design, medium on channel specifics (Teams app details in M6).

## Context

Publishing, pinning, retracting or replacing content must reach the right people on the right channel, including the specific people who saw or asked about an outdated version. Fan-out must be reliable (no lost retraction alerts), deduplicated, rate-limited and respectful of user preferences and quiet hours.

## Decision

1. **Transactional outbox.** Every domain change writes a `domain_event` row (org, type, subject ids, version, actor, payload) in the same transaction. A pg-boss job drains the outbox; events are processed at least once with idempotency keys. For scheduled publishing, the `content.published` row is written by the transition job at `publish_at` (ADR-0003), not at scheduling time, so audience resolution happens when the item is actually reader-visible.
2. **Targeting rules** resolve an event to recipient sets, each with a `reason` code:
   - `audience`: users who can view the content now (visibility predicate, ADR-0002).
   - `saw_version`: users with a `view` or `ack` event on a specific version (from `user_content_state`).
   - `asked_related`: users whose logged questions had an answer citing that content version.
   - `pinned_for`: audience of a pinned announcement.
   - `commented`, `mentioned`, `moderation`.
   Recipient resolution respects permissions at delivery time. A retraction notice goes to `saw_version` and `asked_related` users who are still active members even if they lost access to the item (they need to know what they saw is wrong), but by default it is a **neutral notice** ("something you viewed on <date> has been withdrawn; contact <owner>"). The title is included only when the org enables `notify.include_title_after_access_loss`, and then only the **title snapshot recorded in `user_content_state` at view time**, never the current title (metadata edits do not create versions). Deactivated users are never notified. Moderator-written retraction reasons are never included in notices to users who lost access. A "new version available" link resolves only if the recipient passes `readerVisible` for the new version.
3. **Notification record** per (user, event key) with `dedupe_key = sha256(org, user, type, subject, version)`; duplicates are dropped. Each record tracks channel deliveries and states (queued, sent, failed, read).
4. **Channels** as adapters: in-app (always), email (SMTP or provider adapter), Teams bot proactive message (M6), Expo push (M10), webhook (generic, M3). Channel selection = org policy ∩ user preference ∩ event severity. `retraction` and `pinned_announcement` are "important" and bypass digests but not quiet hours unless the org marks them critical.
5. **Digests.** Non-important events batch per user per channel on a schedule (default hourly in-app badge, daily email). Important events send immediately with rate limiting per user (max N per minute) and collapsing (one message listing several items).
6. **Content of notifications is permission-checked at render time**, not at enqueue time: a notification pointing at content the user can no longer see renders as the neutral message in point 2 (plus the view-time title snapshot only under the org option). Comment-mention notifications are dropped when the mentioned user fails `readerVisible` for the item.
7. **Preferences and compliance**: per-user channel and digest settings; org-level overrides for compliance notices; unsubscribe for email per category except mandatory compliance notices; everything audited.

## Consequences

- Reliable and deduplicated by construction; the outbox table doubles as an audit trail for fan-out.
- Targeting by `saw_version` and `asked_related` requires analytics events (ADR-0006) to be transactional for views and question logs; heartbeats remain best-effort.
- Email and Teams adapters are the only parts with external failure modes; retries with backoff and a dead-letter queue visible to admins.

## Tests

- Publish to a stream with nested groups: recipients equal the visibility predicate result (same fixture matrix as ADR-0002).
- Retract after views: users who viewed v1 receive one retraction notice each, non-viewers in the audience receive the standard removal notice only if the org enables it, duplicates suppressed on replay of the outbox.
- Lost access before delivery: rendered notification contains no content and, by default, no title; with the org option, only the view-time title snapshot. Deactivated users receive nothing. Mention of a non-viewer sends nothing.
- Rate limit and digest timing with a fake clock.
