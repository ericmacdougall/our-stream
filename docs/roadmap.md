# Roadmap: first slice and milestones

Status: proposed, 2026-11-03. Each milestone is independently shippable and demoable from `docker compose up`.

## First end-to-end slice: M1 "Permissioned video feed"

### What ships

A small team or a department can sign up, create streams, upload a clip, publish it to an audience, and everyone in that audience sees it in a captioned vertical feed on web and on the Expo app, can like, comment and share it internally, and the contributor sees who watched. Retracting the clip removes it everywhere at once. The same permission kernel and content pipeline will carry documents and the assistant in M2.

Scope:
- Org signup (email + password, magic link), invite by email, org roles (owner, admin, contributor, member).
- Streams: company-wide (default), department, team, private (invite-only; personal = one member). Stream roles viewer, contributor, moderator, owner; groups (local) assignable to stream roles.
- Upload (web): video or audio via multipart to object storage; pipeline: probe, HLS ladder, poster and sprite, ASR captions (self-hosted whisper sidecar by default, hosted provider optional), manual chapters, links (intranet, internet, attached page).
- Publish: audience (streams, groups, individuals, everyone), draft, scheduled publish, optional expiry, event tags (onboarding, announcement, current events, training), pin to stream.
- Feed (web PWA and Expo): vertical, swipeable, muted autoplay with captions, keyboard navigation, reduced motion, pause auto-advance; filters by stream, department, event tag; pinned announcements on top; like, comment (threaded, moderated), share to a stream or person; "open at chapter".
- Keyword search over titles, descriptions, captions and transcripts with the same visibility predicate; results open the clip at the matching timestamp.
- Engagement: view, progress milestones, complete, rewatch; per-clip stats and viewer list subject to the org privacy mode; per-user "watched" state.
- Retraction and replacement with new version; epoch-based cache invalidation; in-app and email notifications to the audience and to users who viewed the retracted version.
- Signed media delivery through the API proxy; `private, no-store` on all personalised responses.
- Self-host: `docker compose up` (postgres+pgvector, SeaweedFS, api, web, worker, whisper sidecar profile); Helm chart skeleton.
- Quality: permission fixture matrix and leak-check property tests; media security tests; Playwright click tests for signup → upload → publish → feed → like/comment → retract; axe checks; i18n catalogs (en) with ICU; SPDX headers; CI.

Out of scope for M1 (explicitly deferred): documents and the assistant (M2), calendar view and intranet pages (M3), acknowledgements and dashboards (M4), SSO/SCIM (M5), Microsoft integrations (M6), mobile upload and push (M10).

### Why this slice

1. **It exercises the two riskiest foundations under real use**: the permission kernel (ADR-0002) and the versioned content pipeline with invalidation (ADR-0003, ADR-0004). Both are costly to change later; proving them with the feed, where leaks are visible and testable, is safer than proving them first inside a model-driven answer path.
2. **It is the product's identity.** The default landing is the feed; a demo that shows a clip reaching the right people and disappearing on retraction is the pitch.
3. **The RAG slice lands on top, not beside.** Transcripts produced here are the first knowledge; M2 adds document parsing, embeddings and answers using the same visibility predicate, so the leak-check tests written now also gate the assistant.
4. **It needs no paid model spend.** Self-hosted whisper on T2 covers captions; the hosted ASR adapter is optional. The assistant (M2) is where provider keys and spend decisions start, and those are open questions for the user.
5. **It settles the mobile architecture early** (separate Expo UI, shared contracts), as the user asked for native mobile from the start; the Expo app in M1 is read-and-react (sign in, feed, like, comment), upload stays on web until M10.

### M1 acceptance criteria (summary; full list in the scope brief)

- A: two orgs with overlapping emails never see each other's content in feed, search, media or notifications (automated matrix, zero failures).
- B: a clip published to department stream D is visible to D's viewers and not to other members; moving a user out of D hides it within one request after reconcile.
- C: retraction removes the clip from feed, search and media and sends one notice to each viewer of the retracted version, no duplicates on outbox replay.
- D: uploading a 60 s 9:16 clip yields an HLS ladder, poster, sprite and VTT captions; feed plays it on Chrome, Safari and the Expo app; captions toggle; keyboard and reduced-motion work.
- E: Playwright click test of the full flow passes on CI; axe reports no serious violations on feed, upload and sign-in.
- F: `docker compose up` from a clean machine reaches first clip in under 10 minutes following README.

## Milestones after M1

| # | Name | Ships | Depends on |
|---|---|---|---|
| M0 | Foundation | Repo, monorepo, CI, compose, DB with RLS, authz kernel + fixture matrix, design tokens, i18n scaffold, a11y lint, OpenAPI contract, fakes for adapters | – |
| M1 | Permissioned video feed | As above | M0 |
| M2 | Knowledge base and assistant | Document upload and parsing (PDF, DOCX, PPTX, XLSX, MD), chunking, embeddings, hybrid search, permission-filtered answers with citations to clip timestamps and pages, question log, suggested chapters, model-provider policy UI, injection corpus | M1 |
| M3 | Distribution and lifecycle | Calendar filter and view, intranet-style browsing (streams as sections, pages, links), content expiry, scheduled campaigns, generic webhooks, "new version available" targeting to askers, replacement workflow UX | M1 |
| M4 | Insight and attestation | Engagement rollups, team dashboard (questions, frequency, resolved vs unresolved), AI content suggestions, policy acknowledgement/attestation with version tracking and reminders, exports | M2 |
| M5 | Enterprise identity and audit | OIDC (Entra, Okta, Google, generic), SAML, SCIM 2.0 server with conformance suite, group-to-audience mapping, MFA (TOTP, passkeys), audit log UI, session policies | M1 |
| M6 | Microsoft 365 | SharePoint content source with delta, webhooks and ACL mirror; Teams app (bot notifications, personal tab with SSO); Copilot connector export with ACLs | M2, M5 |
| M7 | Learning and language | Learning paths, quizzes feeding the misconception dashboard, expert Q&A routing (named experts; optional GoodQA adapter), multilingual auto-translation of captions, titles and answers (labelled), per-user language | M4 |
| M8 | Trust and compliance | PII/secret scanning, retention policies and legal hold, data-subject export and delete, residency controls, SBOM and signed images, backup/restore runbooks | M2 |
| M9 | Hosted SaaS | Region cells, org provisioning, billing, status page, SLOs, Helm hardening, multi-instance caches (Valkey), support console with audited access | M5, M8 |
| M10 | Mobile parity and creation | Mobile upload and camera capture, push notifications, offline viewing of permitted clips, TTS narration and AI clip creation under provider policy, enterprise app distribution docs | M3, M5 |

Sequencing note: M3 and M5 can run in parallel with M2 by separate owners because they touch different packages (web/feed vs identity vs pipeline/providers); M4 and M6 wait on M2.
