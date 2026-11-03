# Roadmap: first slice and milestones

Status: proposed, 2026-11-03. Each milestone is independently shippable and demoable from `docker compose up`.

## First end-to-end slice: M1 "Permissioned video feed", shipped as M1a and M1b

Revised after plan review round 1 (F5): M1 is split into two shippable increments so the first one depends only on Q2 (email + password + magic link) and Q6 (private streams as member streams), both adopted as the recommended defaults and recorded as assumptions.

### M1a (web only): publish a clip to the right people and withdraw it everywhere

A small team or a department can sign up, create streams, upload a clip, publish it to an audience, and everyone in that audience sees it in a captioned vertical feed on the web; retracting or replacing the clip removes the old version everywhere at once.

Scope:
- Org signup (email + password, magic link), invite by email, org roles (owner, admin, announcer, contributor, member).
- Streams: company-wide (default), department, team, private (invite-only; personal = one member, Q6 recommended semantics, low risk to change). Stream roles viewer, contributor, moderator, owner; local groups assignable to stream roles; publish rules per ADR-0002.
- Upload (web): video or audio via multipart to object storage; pipeline: probe, HLS ladder, poster and sprite, ASR captions (self-hosted whisper sidecar by default, hosted provider adapter with a fake), manual chapters, links (intranet, internet, attached page).
- Publish: audience (streams, groups, individuals, everyone per rules), draft, `publish_at`, `expires_at`; scheduled transitions bump epochs (ADR-0003/0004).
- Web feed: vertical, swipeable, muted autoplay with captions, keyboard navigation, reduced motion, pause auto-advance; filter by stream; "open at chapter". No likes or comments yet.
- Minimal transactional view recording (`view_start` and `complete` into `user_content_state` with the version id and a title snapshot) so retraction targeting works; richer engagement (milestones, rewatch, stats, viewer lists) stays in M1b.
- Transactional auth email (invites, magic links) through an SMTP adapter with a fake and a compose mail catcher; password sign-in works without SMTP. Notification email digests stay in M1b.
- Retraction and replacement with a new version; epoch-based cache invalidation; in-app notifications (neutral notice to viewers of a retracted version per ADR-0005).
- Media through the authenticated proxy re-authorising every request; `private, no-store` on all personalised responses; service worker excludes `/api` and `/media`.
- Self-host: `docker compose up` (postgres+pgvector, SeaweedFS, api, web, worker, whisper profile).
- Quality: fixture matrix (reader, author, auditor predicates) and retrieval-subset property test over seeded chunks; media security tests; Playwright click tests for signup → upload → publish → feed → retract; axe checks; i18n catalogs (en) with ICU; SPDX headers; CI; red-team before PR.

### M1b: react, find and measure, on web and mobile

- Expo read-and-react app (sign-in, feed, like, comment) with server discovery (Q5).
- Likes and comments (threaded, moderated per Q7), share as notification/link only.
- Keyword search over titles, descriptions, captions and transcripts under `readerVisible`, including counts and snippets; results open the clip at the matching timestamp.
- Engagement: view, progress milestones, complete, rewatch; per-clip stats and viewer lists under the org privacy mode (Q1).
- Notification email channel and digests; pinning and event tags (onboarding, announcement, current events, training) with feed filters by department and tag.
- Helm chart skeleton.

Out of scope for M1 (explicitly deferred): documents and the assistant (M2), calendar view and intranet pages (M3), acknowledgements and dashboards (M4), SSO/SCIM (M5), Microsoft integrations (M6), mobile upload and push (M10). Expiry and replacement ship in M1a; M3 only adds campaign scheduling UX and replacement targeting to askers (`asked_related`, which needs M2's question log).

### Why this slice

1. **It exercises the two riskiest foundations under real use**: the permission kernel (ADR-0002) and the versioned content pipeline with invalidation (ADR-0003, ADR-0004). Both are costly to change later; proving them with the feed, where leaks are visible and testable, is safer than proving them first inside a model-driven answer path.
2. **It is the product's identity.** The default landing is the feed; a demo that shows a clip reaching the right people and disappearing on retraction is the pitch.
3. **The RAG slice lands on top, not beside.** Transcripts produced here are the first knowledge; M2 adds document parsing, embeddings and answers using the same visibility predicate, so the leak-check tests written now also gate the assistant.
4. **It needs no paid model spend.** Self-hosted whisper on T2 covers captions; the hosted ASR adapter is optional. The assistant (M2) is where provider keys and spend decisions start, and those are open questions for the user.
5. **It settles the mobile architecture early** (separate Expo UI, shared contracts), as the user asked for native mobile from the start; the Expo app ships in M1b as read-and-react (sign in, feed, like, comment), upload stays on web until M10.
6. **M1a depends only on Q2 and Q6**, taken as the recommended defaults (both cheap to change); privacy mode (Q1), mobile server discovery (Q5) and moderation defaults (Q7) only affect M1b.

### M1a acceptance criteria (summary; full list in the scope brief)

- A: two orgs with overlapping emails never see each other's content in feed, media or notifications (automated matrix, zero failures, with RLS on and deliberately off).
- B: a clip published to department stream D is visible to D's viewers and not to other members; removing a user from D (or from a 10k-member group granting D) hides it on that user's next request, with no asynchronous step.
- B2: a draft is never visible in the feed or media to anyone, including its owner; a deactivated user with a live session is refused on the next feed, media and `/sync` request.
- C: retraction removes the clip from feed and media on the next request and sends one neutral notice to each viewer of the retracted version, no duplicates on outbox replay; an expiry disappears from a cached feed within 60 s without a write.
- D: uploading a 60 s 9:16 clip yields an HLS ladder, poster, sprite and VTT captions; the web feed plays it on Chrome and Safari; captions toggle; keyboard and reduced-motion work.
- E: Playwright click test of signup → upload → publish → feed → retract passes on CI; axe reports no serious violations on feed, upload and sign-in.
- F: `docker compose up` from a clean machine reaches first clip in under 10 minutes following README.

M1b adds: search results, counts and snippets agree with the matrix; the Expo app plays the feed; privacy mode `aggregate_only` leaks no user ids; like/comment idempotency under double submit.

## Milestones after M1

| # | Name | Ships | Depends on |
|---|---|---|---|
| M0 | Foundation | Repo, monorepo, CI, compose, DB with RLS and schema lint, authz kernel with `readerVisible`/`authorAccessible`/`auditorAccessible`, reference implementation and fixture matrix, a `chunk` table with tsvector and the retrieval-subset property test (so the predicate is proven over chunks before M2), design tokens, i18n scaffold, a11y lint, OpenAPI contract, fakes for adapters, rollout procedure (ADR-0012) | – |
| M1a | Permissioned video feed, web | As above | M0 |
| M1b | React, find and measure; Expo | As above | M1a, Q1, Q5, Q7 |
| M2 | Knowledge base and assistant | Document upload and parsing (PDF, DOCX, PPTX, XLSX, MD), chunking, embeddings, hybrid search, permission-filtered answers with citations to clip timestamps and pages, question log, suggested chapters, model-provider policy UI, injection corpus | M1a (search UI from M1b) |
| M3 | Distribution and lifecycle | Calendar filter and view, intranet-style browsing (streams as sections, pages, links), scheduled campaigns, generic webhooks, "new version available" targeting to askers (`asked_related`) | M1b, M2 for `asked_related` |
| M4 | Insight and attestation | Engagement rollups, team dashboard (questions, frequency, resolved vs unresolved), AI content suggestions, policy acknowledgement/attestation with version tracking and reminders, exports | M2 |
| M5 | Enterprise identity and audit | OIDC (Entra, Okta, Google, generic), SAML, SCIM 2.0 server with conformance suite, group-to-audience mapping, MFA (TOTP, passkeys), audit log UI, session policies | M1a |
| M6 | Microsoft 365 | SharePoint content source with delta, webhooks and ACL mirror; Teams app (bot notifications, personal tab with SSO); Copilot connector export with ACLs | M2, M5 |
| M7 | Learning and language | Learning paths, quizzes feeding the misconception dashboard, expert Q&A routing (named experts; optional GoodQA adapter), multilingual auto-translation of captions, titles and answers (labelled), per-user language | M4 |
| M8 | Trust and compliance | PII/secret scanning, retention policies and legal hold, data-subject export and delete, residency controls, SBOM and signed images, backup/restore runbooks | M2 |
| M9 | Hosted SaaS | Region cells, org provisioning, billing, status page, SLOs, Helm hardening, multi-instance caches (Valkey), support console with audited access | M5, M8 |
| M10 | Mobile parity and creation | Mobile upload and camera capture, push notifications, offline viewing of permitted clips, TTS narration and AI clip creation under provider policy, enterprise app distribution docs | M3, M5 |

Sequencing note: M3 and M5 can run in parallel with M2 by separate owners because they touch different packages (web/feed vs identity vs pipeline/providers); M4 and M6 wait on M2.
