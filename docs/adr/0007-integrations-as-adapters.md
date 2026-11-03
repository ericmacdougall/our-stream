# ADR-0007: Integrations as adapters (identity, SharePoint, Teams, Copilot, GoodQA)

Status: proposed, 2026-11-03. Confidence: high on interfaces; medium on Microsoft specifics until tested in a tenant.

## Context

Enterprise value depends on fitting into Microsoft 365, identity providers and existing Q&A tooling, while small teams need none of it. Each integration must be optional, testable without the vendor, and bounded in what it can see or do. Research notes (docs/research, 2026-11-03) fix the current platform facts: Teams incoming webhooks retired (May 2026); Bot Framework unmaintained (use Teams SDK v2 / Agents SDK); Copilot connectors require per-item ACLs; Graph has no effective-permission endpoint; Entra, Okta and Google SCIM behaviours differ; Google custom SCIM is beta.

## Decision

### Interfaces (in `packages/contracts/integrations`)

- `IdentityProvider`: `startLogin`, `handleCallback` → `{ externalId, email, name, groups?, idpTenant }`. Implementations: `oidc` (openid-client v6; Entra multitenant with `tid` and templated issuer validation; Okta org AS with groups claim; Google with `hd` claim check; generic), `saml` (`@node-saml/node-saml` ≥ 5.2, signed assertions, audience/issuer/InResponseTo/replay checks, XML size cap).
- `DirectorySync`: inbound SCIM 2.0 server at `/scim/v2` per org connection with hashed bearer tokens; normalisation layer (lowercase ops, string booleans, path-less replace, both member-removal shapes, 201/204/409 semantics, `/Schemas`, `/ServiceProviderConfig`, `/ResourceTypes`, filters `userName`, `externalId`, `emails[type eq "work"].value`, `displayName`). Optional pull sync for Google via the Admin SDK Directory API with domain-wide delegation. Deprovisioning sets `active=false` (never hard delete without retention policy consent).
- `ContentSource`: `discover`, `crawl(deltaToken)`, `fetch(item)`, `acl(item)`, `subscribe`, `webhook(payload)`. Implementation `sharepoint`: Graph drive delta, change notifications on `/drives/{id}/root` with `clientState` and 202-then-queue handling, daily catch-up delta, `Sites.Selected` minimum with documented `Sites.FullControl.All` for full permission mirroring; ACL expansion of `grantedToV2` principals to mapped users/groups; unresolvable principals → no audience (fail closed) and admin report.
- `Messenger`: `send(recipient, message)`, `cardFor(notification)`. Implementations: `email` (SMTP/provider), `teams` (Teams SDK v2 bot with proactive messages, Adaptive Cards ≤ 1.6, personal tab with tab SSO embedding the web app), later `slack`.
- `KnowledgeExport`: `upsert(contentVersion, acl)`, `delete(contentVersionId)`. Implementation `copilot-connector`: `externalConnection` + schema + `externalItem` per published version with `acl` from `content_audience` (Entra user/group ids where mapped, `externalGroup` for local groups), respecting the 30 MB text and concurrency limits; unmappable audiences are not exported; retraction deletes.
- `QaRouter`: `escalate(question, context)`, `resolve(callback)`. Implementation `goodqa` (optional): files unresolved questions as GoodQA issues under a configured project and pulls answers back to mark questions resolved and suggest content. Exact GoodQA API surface to be confirmed with the user.

### Cross-cutting rules

- Per-org integration config with secrets encrypted by envelope encryption (org data key wrapped by a KMS or a local master key); secrets never logged; rotation supported.
- Every adapter ships a `fake` implementation used by tests and by the compose demo; vendor conformance suites (Okta Runscope SCIM tests, Entra behaviours in both flag modes, Google beta behaviours) run in CI against the SCIM server.
- Webhook endpoints validate signatures or `clientState`, respond fast and enqueue; replay protection by event id.
- Integrations are feature-flagged per org and visible in the audit log.
- Least privilege documented per integration with the exact Graph permissions requested.

## Consequences

- Small teams run with zero integrations; enterprise installs add them per org.
- Microsoft specifics (bot registration, manifest 1.29, gallery listing) are operational work tracked in M6, not architectural risk.
- Own SCIM server is ~1-2k lines plus conformance tests; avoids coupling the user model to a third-party auth framework.

## Alternatives

- Better Auth / Auth.js for SSO: Auth.js v5 is perpetual beta and superseded; Better Auth is viable but its SAML rides on samlify and SCIM maturity is unproven; we keep our own session/user model and use primitives (openid-client, node-saml).
- Ory Polis (Apache-2.0) as an SSO+SCIM service: acceptable fallback if our own SCIM server proves costly; adds a service.
