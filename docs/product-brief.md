# our-stream product brief

Status: draft v0.1, 2026-11-03. Owner: product/architecture. License: AGPL-3.0-only.

## One line

our-stream is an open-source, self-hostable enterprise platform for **knowledge streams**: a TikTok-style feed of short internal video clips that keeps large teams in sync, backed by a **permission-filtered knowledge base** (retrieval-augmented answers over the company's own documents, slides, videos and data) where every recall and lookup is gated by deterministic authorization, never by a model.

## Who it is for

| Actor | Needs |
|---|---|
| Employee (viewer) | Open the app and immediately see what matters today: announcements, onboarding, team updates, training clips. Ask a question and get an answer with sources they are allowed to see, linking to the exact clip timestamp or page. |
| Contributor (HR, trainers, managers, team leads) | Upload a clip, deck, PDF, spreadsheet or audio; choose who sees it and when; see who watched, rewatched, commented or acknowledged; find out what people are still confused about. |
| Stream moderator / department admin | Curate a department stream, pin announcements, moderate comments, schedule campaigns (onboarding week, policy rollout). |
| Org admin / IT | Configure SSO and SCIM, SharePoint/Teams/Copilot integrations, model providers and data-residency policy, retention and legal hold, audit logs; self-host with Docker or Kubernetes, or use the hosted service. |
| Small team / individual | Sign up with email, create a workspace, start sharing clips with a few people without any IT involvement. |

## The problem

Large organizations drown in documents nobody reads and meetings nobody remembers. Policies change and the people who saw the old version are never told. New hires ask the same questions in private chats. Training content sits in a folder on SharePoint. Existing intranets are browse-first and ignored; chat tools are ephemeral; LMSs are heavy. Generic "chat with your docs" tools leak content across permission boundaries or cannot explain why an answer exists.

## The product

1. **Knowledge streams.** Content is published into streams: company-wide, department, team, project, and private (invite-only or personal). A user's feed is the union of streams they can see, ranked by recency, pins, relevance and what they have not yet watched.
2. **The feed.** The default landing page is a vertical, swipeable, captioned video feed (web PWA and native mobile). Each clip has a title, captions, chapters, links (intranet, internet, attached pages or documents), likes, internal shares and comments. Announcements can be pinned. Filters: stream, department, event type (onboarding, current events, announcements, training), calendar/date range.
3. **Knowledge base and assistant.** Uploaded documents, decks, spreadsheets, audio and video become searchable knowledge. Users ask questions; the assistant retrieves only chunks the user is permitted to see (deterministic SQL filter), answers with citations that link to the clip timestamp or document page, and logs the question. Content a user may not see never enters the model context.
4. **Publishing workflow.** On upload, contributors choose distribution (streams, groups, individuals, everyone), draft mode, scheduled publish and optional expiry, event tags, pinning and whether acknowledgement is required. Versions are tracked; retraction or replacement is immediate and can alert exactly the people who saw or asked about the old version.
5. **Engagement and insight.** Per-content stats (views, completion, rewatch, comments, acknowledgements); per-team dashboard of questions asked, frequency, resolved vs unresolved, and AI-generated suggestions for new material that would address recurring unknowns and misconceptions.
6. **Enterprise plumbing.** SSO (OIDC and SAML with Entra ID, Okta, Google Workspace and any standards-compliant IdP), SCIM provisioning, SharePoint as a content source with mirrored permissions, Teams notifications and tab app, Microsoft 365 Copilot connector export, optional GoodQA routing for expert Q&A, audit logs, retention and legal hold, data residency and zero-data-retention model policies, optional PII and secret scanning on upload.
7. **Operability.** Single `docker compose up` for evaluation, Helm chart for Kubernetes, Postgres + pgvector as the only database, S3-compatible object storage, a Postgres-backed job queue by default, OpenTelemetry tracing and structured logs. A hosted SaaS option runs the same code with region-pinned tenants.

## Explicit requirements (from the request)

- Streams: company-wide, department, private/individual.
- Default landing: tailored video feed with like, share (internal) and comment.
- Videos: titles, captions, chapters, links to intranet, internet or attached pages.
- RAG / agentic knowledge base with strict, deterministic authorization at recall and lookup.
- Uploads by HR, teams, trainers, managers, admins: docs, data, presentations, video, audio, PDFs, spreadsheets; distribution choice, draft mode, future scheduling.
- Filters: stream, department, event type (onboarding, current events, announcements); pinned announcements.
- Tracking: who saw, watched, rewatched, commented; engagement stats.
- Team dashboard: questions asked, frequency, unresolved vs solved; AI suggestions for new material.
- Calendar filter and view; intranet-style browsing.
- Integrations: SharePoint, Teams, Copilot, optional GoodQA; Okta, Entra, Google and other major IdPs (SSO + SCIM); plain signup for small teams and individuals.
- Video and TTS model integrations with privacy, sovereignty and ZDR guidance.
- Optional PII and secret scanning on upload.
- Caching with automatic cache busting on retraction or change; notifying users; linking content; targeting users who saw or asked about something so that those who saw a wrong or outdated version are alerted.
- Self-hostable (Docker, Kubernetes) and optional hosted SaaS; AGPL-3.0; TypeScript (Next.js web, Node API), Postgres + pgvector, S3-compatible storage, a job queue; native mobile (Expo) plus web PWA from the start.

## Proposed additional scenarios (inferred; confirm or cut)

| Scenario | Why | Milestone |
|---|---|---|
| Policy acknowledgement / attestation | Compliance teams need proof that a person saw and accepted a policy version; pairs naturally with retraction alerts. | M4 |
| Learning paths and quizzes | Onboarding and training are sequences, not single clips; a short quiz turns passive watching into measurable understanding and feeds the "misconceptions" dashboard. | M7 |
| Expert Q&A routing | Unresolved questions should reach a named expert (or GoodQA) and the answer should become a clip or page, closing the loop. | M7 |
| Multilingual auto-translation | Large teams span languages; captions, titles and answers should be available in the viewer's language, marked as machine-translated. | M7 |
| Search (keyword + semantic, permission-filtered) | Not everything is a question; browsing and search must apply the same filter as retrieval. | M1 (keyword), M2 (hybrid) |
| Accessibility | Captions, transcripts, keyboard navigation, reduced motion, pause control for autoplay, screen-reader labels, contrast. Legal requirement in many jurisdictions (EU EAA 2025, ADA, AODA). | M1 onward |
| Retention and legal hold | Enterprises must delete on schedule and must not delete under hold. | M8 |
| Audit log | Who published, retracted, changed audience, exported, configured identity or model providers. | M5 |
| Data residency and model policy | Per-org pinning of storage region and allowed model vendors/regions, require-ZDR switch, self-host-only mode. | M2 (policy), M9 (multi-region hosted) |
| Offline and push on mobile | Field staff; push for pinned announcements and retractions. | M10 |
| Content expiry | Time-boxed announcements should leave the feed automatically. | M1a |

Deferred unless the outcome requires them: live streaming, external (customer-facing) sharing, payments beyond hosted billing, a full LMS with SCORM, meeting recording bots.

## Non-goals for v1

- Replacing SharePoint or a document management system as the system of record; our-stream indexes and references, it does not become the canonical store for SharePoint documents.
- Public social features (external followers, public profiles).
- Model training on customer data. Never.

## Success measures (v1)

- Time-to-first-clip for a new workspace under 10 minutes from `docker compose up`.
- 100% of permission tests pass; zero cross-tenant or cross-audience leaks in the red-team suite; retrieval results are provably a subset of `readerVisible` (ADR-0002), and no reader path ever returns a draft.
- Feed first paint under 2 s on a mid-range phone over 4G with HLS startup under 1 s on cached ladders.
- Retraction to feed removal and alert delivery under 60 s end to end.
- WCAG 2.2 AA on the feed, upload and ask flows (automated axe plus manual keyboard/screen-reader pass).

## Product principles

1. **Authorization is data, not inference.** Visibility is decided by SQL over explicit grants. Models only ever see what the user may see.
2. **Versioned truth.** Every published artifact has a version; everything derived (captions, chunks, embeddings, caches, Copilot exports) is keyed by that version and invalidated with it.
3. **Self-host first.** Every feature works on a single VM with Postgres, object storage and ffmpeg. Hosted services are adapters.
4. **Honest AI.** Answers cite sources; generated suggestions, translations and summaries are labelled; the system says "I do not have that" rather than inventing.
5. **Accessible and multilingual by default.** Captions, transcripts, keyboard, reduced motion, i18n strings from day one.
