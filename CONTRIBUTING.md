# Contributing to our-stream

Thank you for considering a contribution. The platform is licensed under AGPL-3.0-only, `apps/mobile` under Apache-2.0, and `packages/contracts` under AGPL-3.0-only OR Apache-2.0; by contributing you agree that your contribution is licensed under the terms of the directory it touches.

## Ground rules

- Be kind; see `CODE_OF_CONDUCT.md`.
- Sign off every commit (DCO): `git commit -s`. The sign-off certifies the Developer Certificate of Origin 1.1 (https://developercertificate.org/).
- Never commit secrets, customer data, or private documents. Fixtures must be synthetic.
- Every source file carries an SPDX header: `// SPDX-License-Identifier: AGPL-3.0-only`.
- Dependencies must be MIT, Apache-2.0, BSD, ISC, PostgreSQL or MPL-2.0 licensed; AGPL components run as separate services, never vendored. CI enforces this.

## Workflow

1. Open or pick an issue; for substantial changes, discuss the design first (an ADR in `docs/adr/` for anything costly to reverse).
2. Branch from `main`, use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
3. Write a failing test first for behaviour changes. Permission-related changes must extend the fixture matrix in `packages/authz`.
4. Run `pnpm lint`, `pnpm typecheck`, `pnpm test` locally; integration tests need Docker for Postgres.
5. Open a pull request with: what changed, why, how it was tested, screenshots for UI, and documentation updates.
6. Maintainers review for correctness, security (especially tenancy and permissions), accessibility and documentation.

## Development setup

See `docs/development.md` (to be added with the M0 scaffold) for prerequisites (Node 24, pnpm, Docker, ffmpeg), `docker compose up`, seeding demo content and running the apps.

## Security issues

Do not file security issues publicly; see `SECURITY.md`.
