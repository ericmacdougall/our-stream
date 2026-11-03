# Security policy

## Reporting a vulnerability

Please do not open public issues for security problems.

Report privately through GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). If that is unavailable, open a minimal public issue asking for a private contact without including details, and a maintainer will respond with a private channel.

Include: affected component and version or commit, reproduction steps, impact (for example cross-tenant or cross-audience exposure, authentication bypass, media URL exposure), and any proof-of-concept. Please give us a reasonable time to fix before public disclosure; we aim to acknowledge within 3 business days and to ship a fix or mitigation for critical issues within 14 days.

## Scope

In scope: this repository's code, default Docker Compose and Helm configurations, and documentation that could lead operators into an insecure deployment.

Out of scope: third-party services (identity providers, model vendors), issues requiring a compromised host, and findings in dependencies already reported upstream (please report those upstream and let us know).

## Security design

Key controls are documented in `docs/adr/`: row-level tenancy with Postgres RLS (ADR-0001), deterministic permission filtering for retrieval (ADR-0002), signed media delivery and versioning (ADR-0003), cache invalidation (ADR-0004), model-provider policy (ADR-0008), upload scanning (ADR-0009), prompt-injection defences (ADR-0010). The risk table is in `docs/risk-table.md`.

## Supported versions

Pre-release: only the `main` branch receives fixes until the first tagged release.
