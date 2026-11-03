# ADR-0011: Stack, repository conventions and licensing

Status: proposed, 2026-11-03. Confidence: high (versions verified in docs/research on 2026-11-03; pin at scaffold time).

## Decision

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere, Node 24 LTS runtime (Node 22 is in maintenance and reaches end of life April 2027; Expo 58's >= 22.13 floor is satisfied) | one language, shared contracts |
| Monorepo | pnpm workspaces + Turborepo; isolated node linker (hoisted only if Expo needs it) | shared content-addressed store, lean worktrees |
| Web | Next.js 16.4.x App Router, `proxy.ts` for optimistic checks, Data Access Layer that calls the API only (Next.js never connects to Postgres; the API is the single authorization surface), Serwist PWA with `/api` and `/media` excluded from runtime caching, Turbopack | current stable; official auth and PWA guidance |
| API | Fastify 5 + Zod type provider + `@fastify/swagger` (OpenAPI 3.1 as the contract); SSE for streaming | boring, mature plugins, REST is the integration surface |
| Clients | `openapi-typescript` + `openapi-fetch` generated from the spec in `packages/contracts` | one contract for web, mobile and integrators |
| Mobile | Expo SDK 58, Expo Router, expo-video, expo-file-system, expo-secure-store, expo-auth-session; separate UI from web, shared packages | research: no sound shared-UI path today |
| DB | Postgres 17 + pgvector 0.8.x; Drizzle ORM pinned to 0.45.x (not the 1.0 RC) for application tables and queries; RLS policies, roles, triggers, definer functions, vector indexes and partitions as hand-written SQL migrations (ADR-0012) | pgvector + RLS first class; security objects reviewed as SQL |
| Queue | pg-boss 12 | Postgres-only self-host |
| Storage | S3 API via AWS SDK v3; SeaweedFS bundled for dev/self-host (Garage alternative); Uppy multipart uploads | MinIO community archived 2026-04 |
| Cache | in-process + Postgres; optional Valkey | licensing, simplicity |
| Media | ffmpeg in worker image; hls.js on web; expo-video on mobile | standard |
| Auth | own session model; argon2id passwords, magic links, TOTP (otplib), passkeys (SimpleWebAuthn); openid-client 6; node-saml >= 5.2; own SCIM server | AGPL-compatible, no paid dependency |
| Observability | OpenTelemetry JS 3.x, pino, Prometheus metrics endpoint; Sentry optional (operate, never bundle) | standard |
| Deploy | Docker images (distroless/node:22-slim), docker compose, Helm chart with CloudNativePG | no Bitnami |
| Testing | Vitest; Playwright 1.64 (web e2e, click tests); Maestro or Detox for mobile smoke (M10); testcontainers for Postgres; fakes for every adapter | failing-first tests required |
| Lint/format | ESLint (typescript-eslint), Prettier, eslint-plugin-jsx-a11y, custom rule banning permissioned accessors in `"use cache"` | quality gates |
| i18n | ICU messages via `@formatjs` (web and mobile), locale negotiation, RTL-ready layout tokens | i18n from day one |
| Design | small token-based design system in `packages/ui`; WCAG 2.2 AA target | accessibility |
| License | AGPL-3.0-only for the platform; SPDX header on every source file; `REUSE.toml`; third-party license report in CI; the web UI and mobile app show an AGPL §13 "source code" link pointing at the running version's commit; licensing of `apps/mobile` for app-store distribution is an open question (Q13) to settle before the first external contribution | public repo hygiene |

## Repository conventions

- Conventional commits; `main` protected; feature branches; squash merge; CI must pass (lint, typecheck, unit, integration with Postgres, e2e smoke, license and dependency audit, SBOM).
- `SECURITY.md` with private disclosure, `CONTRIBUTING.md`, Contributor Covenant 2.1 code of conduct, DCO sign-off.
- No secrets, no customer data, no fixtures derived from private material; synthetic demo content only (generated clips and documents in `fixtures/`).
- Every ADR has tests listed; every milestone ships with docs updates.
- Dependencies pinned via lockfile; Renovate for updates; licenses limited to MIT/Apache-2.0/BSD/ISC/PostgreSQL/MPL-2.0 (sidecars) for bundled code; AGPL components run as separate services.
