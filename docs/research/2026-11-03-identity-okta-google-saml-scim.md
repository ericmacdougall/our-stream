# Research: Okta, Google Workspace, SAML, SCIM, OIDC and MFA libraries for Node

Researched 2026-11-03. [V] verified on the cited page, [I] inference. Confidence in brackets.

## Okta

- Org vs custom authorization server: https://developer.okta.com/docs/concepts/auth-servers/ [V, high]. For SSO into our app use the org authorization server and consume the ID token; custom servers need the API Access Management add-on.
- OIN prerequisites: https://developer.okta.com/docs/guides/submit-app-prereq/main/ [V, high]. OIDC submissions: Web Application type, org AS only, no refresh tokens or `offline_access`, no custom scopes, do not trust `email_verified`, multi-tenant SaaS only. SAML: SHA-256, SP-initiated SLO unsupported.
- PKCE: https://developer.okta.com/docs/guides/implement-grant-type/authcodepkce/main/ [V, high]. Use confidential client plus PKCE S256.
- Groups claim: https://developer.okta.com/docs/guides/customize-tokens-groups-claim/main/ [V, high]. Configured per app on the org AS, appears in the ID token (fat token) for the authorization-code flow.
- SCIM 2.0 server requirements: https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/ (last updated 2026-10-30) and https://developer.okta.com/docs/guides/scim-provisioning-integration-prepare/main/ [V, high]. `GET /Users?filter=userName eq "x"`, pagination by 100 with stable ordering, `POST /Users` must echo the resource, `PUT /Users/{id}` for attribute updates, `PATCH` for activation/deactivation (`{"op":"replace","value":{"active":false}}` with no `path`), group membership PATCH with `members[value eq "id"]`. Okta never sends `DELETE /Users/{id}`; `DELETE /Groups/{id}` can occur. Required attrs `userName`, `name.givenName`, `name.familyName`, `emails`, `active`; ids must not contain `bulkId`; 409 on duplicate. Basic auth not accepted for OIN.
- Testing: https://developer.okta.com/docs/guides/scim-provisioning-integration-test/main/ [V, high]. Runscope SCIM 2.0 spec test suite plus Okta SCIM Test Plan.

## Google Workspace

- OIDC `hd`: https://developers.google.com/identity/openid-connect/openid-connect [V, high]. The `hd` request parameter is only a hint; enforce by validating the `hd` claim in the ID token. No groups claim in Google ID tokens; use the Directory API [I].
- Google as SAML IdP for custom apps: https://knowledge.workspace.google.com/admin/apps/set-up-your-own-custom-saml-app (updated 2026-10-26) [V, high]. ACS must be https; group membership attribute up to 75 groups.
- Automated provisioning (SCIM) to custom SAML apps: https://knowledge.workspace.google.com/admin/users/advanced/automated-user-provisioning-with-custom-scim-profiles (2026-10-29) [V, high]. **Beta, limited participants.** Bearer token only; POST/GET/PATCH (PUT fallback)/DELETE; real `DELETE /Users/{id}` on hard delete; connection test needs 201. Do not depend on it for customers.
- Admin SDK Directory API with domain-wide delegation: https://developers.google.com/workspace/admin/directory/v1/guides/authorizing and https://developers.google.com/workspace/admin/directory/v1/guides/delegation [V, high]. Read-only scopes for users, groups, members, org units; impersonate an admin via service account; public apps with sensitive scopes need OAuth verification (medium).

## SCIM 2.0 standard essentials

RFC 7644 https://www.rfc-editor.org/rfc/rfc7644.html (with RFC 7643, 7642) [V, high]. Endpoints `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`, `/Users`, `/Groups`; media type `application/scim+json`; PUT MUST, PATCH SHOULD; filters `eq ne co sw ew pr gt ge lt le`, `and or not`, bracket filters; 1-based `startIndex`; `count=0` returns only `totalResults`; PATCH ops atomic and ordered; 201 create, 204 delete, 404 after delete, 409 `uniqueness`; bearer tokens over TLS.

Entra requirements and quirks: https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups (2026-09-15) and https://learn.microsoft.com/en-us/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility (2025-08-25) [V, high]. See the Microsoft research note for details.

Server design rules derived [I, medium-high]:

1. Normalise `op` to lowercase; coerce `"True"`/`"False"` strings for `active`.
2. Accept PATCH with and without `path`; accept both member-removal shapes.
3. Implement `/Schemas`, `/ServiceProviderConfig`, `/ResourceTypes`; return 201 on create, 204 on delete, 409 on duplicate `userName` or `externalId`; `userName` matching case-insensitive.
4. Treat `DELETE /Users/{id}` as hard delete or deactivate according to per-tenant policy (retention and legal hold apply).
5. Per-connection random bearer tokens stored hashed, rotatable; gallery listings later require OAuth client credentials.
6. Conformance suite in CI: Okta Runscope JSON, Entra behaviours (both flag modes), Google beta behaviours.

## SAML 2.0 libraries

- `@node-saml/node-saml` 5.2.0 (2026-10-26), MIT: https://github.com/node-saml/node-saml/releases [V, high]. Critical advisories CVE-2025-54369 (fixed 5.1.0) and audience-restriction fix (5.0.0/4.0.5); 5.2.0 adds issuer check, replay rejection, tighter InResponseTo. Pin >= 5.2.0.
- `samlify` 2.15.1 (2026-10-21), MIT [V, high]. CVE-2025-47949 signature wrapping fixed 2.10.0; 2.15.0 security release closed cert-from-message, audience/destination/recipient and replay gaps.
- Recommendation [I, medium-high]: `@node-saml/node-saml` used directly (not the Passport wrapper), require signed assertions, validate audience, issuer, InResponseTo, cap XML size.

## OIDC and auth libraries

- `openid-client` 6.8.9 (2026-11-02), MIT, certified RP; functional API (`discovery`, `buildAuthorizationUrl`, `authorizationCodeGrant`, PKCE helpers): https://github.com/panva/openid-client [V, high].
- Auth.js / next-auth: v5 still beta; stewardship moved to Better Auth 2025-09-22, which recommends new projects start with Better Auth [V, high]. Avoid for new work.
- Better Auth 1.7.16, MIT; `@better-auth/sso` (OIDC + SAML via samlify) and `@better-auth/scim` (inbound SCIM) MIT [V, high on license; medium on SCIM maturity].
- Lucia v3 deprecated [V, high]. Do not use.
- BoxyHQ Jackson, now Ory Polis, Apache-2.0: SAML/OIDC SSO plus Directory Sync (SCIM): https://github.com/ory/polis [V, high]. Runs embedded or as a separate service.
- WorkOS: hosted only, per-connection pricing from $125 per connection: https://workos.com/pricing [V, high].

Strategy for our-stream (ADR-0007 identity section) [I, medium-high]: own session and user model; `openid-client` for OIDC (Entra, Okta, Google, generic); `@node-saml/node-saml` for SAML; own SCIM 2.0 server module with the normalisation rules above and a conformance suite; passwords and magic links for small teams; all dependencies MIT or Apache-2.0.

## Passkeys and TOTP

- `@simplewebauthn/server` 14.0.3, MIT, Node >= 20: https://github.com/MasterKale/SimpleWebAuthn/releases [V, high].
- `otplib` 13.6.0, MIT, plugin-based rewrite, RFC 6238/4226 [V, high].
- `@oslojs/otp` marked deprecated on npm (2026-07-29) [V, high on flag]. Avoid.

## Deprecations and preview summary

Google custom-SCIM provisioning beta; Okta OIN forbids custom AS, refresh tokens and basic-auth SCIM; Entra legacy PATCH behaviour still default without `aadOptscim062020`; Auth.js v5 perpetual beta; Lucia deprecated; `@oslojs/otp` deprecated; node-saml < 5.1.0 and samlify < 2.15.0 carry critical advisories.
