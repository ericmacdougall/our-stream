# our-stream

Open-source enterprise knowledge streams: a TikTok-style feed of short internal video clips that keeps large teams in sync, backed by a permission-filtered knowledge base where every retrieval is gated by deterministic authorization, never by a model.

Status: pre-alpha. Architecture and roadmap are being defined; see `docs/`. Nothing here is production-ready yet.

## What it will do

- Knowledge streams: company-wide, department, team, project and private streams; a personalised vertical video feed as the default landing page, with captions, chapters, links, likes, internal shares and comments.
- Publishing workflow for HR, trainers, managers and admins: upload video, audio, documents, slides, PDFs and spreadsheets; choose audience, draft, schedule, expiry, pins and acknowledgement.
- Knowledge assistant: answers with citations to the exact clip timestamp or document page, using only content the asker is permitted to see.
- Engagement and insight: who watched, rewatched, commented or acknowledged; a team dashboard of questions asked, unresolved topics and AI-suggested new material.
- Enterprise plumbing: SSO (OIDC, SAML) and SCIM with Entra ID, Okta, Google Workspace and others; SharePoint, Teams and Microsoft 365 Copilot integrations; audit logs, retention and legal hold, data residency and zero-data-retention model policies; optional PII and secret scanning.
- Self-hostable with Docker Compose or Kubernetes; optional hosted service.

## Documents

- `docs/product-brief.md`: outcome, actors, scope, principles.
- `docs/architecture.md`: system map.
- `docs/adr/`: architecture decision records (tenancy, permissions, pipeline, caching, notifications, analytics, integrations, model providers, scanning, prompt-injection, stack).
- `docs/roadmap.md`: the first end-to-end slice and milestones.
- `docs/risk-table.md`: risks, controls and proofs.
- `docs/research/`: dated notes from official vendor documentation.
- `docs/open-questions.md`: product questions awaiting decisions.

## Stack

TypeScript monorepo (pnpm): Next.js web PWA, Fastify API with OpenAPI, pg-boss workers, Expo mobile app; Postgres with pgvector; S3-compatible object storage; ffmpeg; pluggable model providers (self-hosted by default).

## License

AGPL-3.0-only. See `LICENSE`. Contributions are accepted under the same license with a DCO sign-off; see `CONTRIBUTING.md`.

## Security

Please report vulnerabilities privately as described in `SECURITY.md`.
