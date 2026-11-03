# Research: Microsoft Graph (SharePoint), Teams, Copilot extensibility, Entra ID

Researched 2026-11-03 from learn.microsoft.com. Dates are each page's `updated_at`. Confidence H/M/L. Inference is marked.

## SharePoint / OneDrive via Microsoft Graph

- driveItem delta: https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0 (2026-06-06), H. `GET /drives/{id}/root/delta`; follow `@odata.nextLink`, persist `@odata.deltaLink`; `?token=latest` skips the initial crawl. Deleted items carry a `deleted` facet; items can repeat (last wins); track by id, not path. `410 Gone` with `resyncChangesApplyDifferences` / `resyncChangesUploadDifferences` forces re-enumeration. App-only least privilege for content: `Files.Read.All`. Permission-change tracking needs `Prefer: deltashowsharingchanges` (+ `deltashowremovedasdeleted, deltatraversepermissiongaps`) and the doc states the app needs `Sites.FullControl.All` to process permissions correctly.
- Scan guidance: https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/scan-guidance?view=odsp-graph-online (2026-05-14), H. Discover → crawl (delta) → notify (webhook, `prefer:includesecuritywebhooks` for permission changes) → process (delta). Daily catch-up delta. Honor `Retry-After`; throttling is per app per tenant.
- List permissions: https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions?view=graph-rest-1.0 (2025-07-23), H. Returns direct and inherited permissions with `roles`, `grantedToV2`, `grantedToIdentitiesV2`, `link.scope`. No "effective permission for user X" endpoint exists (M; absence verified across three docs). Inference: ACL mirroring must expand principals ourselves (users, Entra groups via `transitiveMembers`, sharing-link scopes). SharePoint site groups are not Entra objects and cannot be resolved via Graph (M).
- Selected permissions: https://learn.microsoft.com/en-us/graph/permissions-selected-overview (2026-02-26), H. `Sites.Selected` and the `*.SelectedOperations.Selected` scopes are least privilege for reading; a site admin must grant the app per site via `POST /sites/{id}/permissions`. Trade-off: permission scanning headers require `Sites.FullControl.All`. Validate in a test tenant.
- Change notifications: https://learn.microsoft.com/en-us/graph/change-notifications-overview (2026-04-07), H. driveItem subscriptions only at `/drives/{id}/root`; max lifetime 42,300 minutes; latency usually under a minute, up to 6 h. Webhook delivery https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks (2026-04-22): validation token echo within 10 s as text/plain; verify `clientState`; respond 2xx within 3 s (return 202 and queue); retries up to 4 h. Lifecycle notifications https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events (2026-04-07): `reauthorizationRequired`, `subscriptionRemoved`; `lifecycleNotificationUrl` must be set at creation.

Design consequence for our-stream (ADR-0007): SharePoint adapter = delta crawl + webhook nudges + daily catch-up; ACL mirror expands `grantedToV2` into our principal tables; items whose principals cannot be resolved are **not visible** (fail closed); minimum tenant grant is `Sites.Selected` for content, with an optional "full permission mirror" mode that documents the `Sites.FullControl.All` requirement.

## Teams

- Incoming webhooks and Office 365 connectors were retired in May 2026: https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook (2026-10-28), H. Replacement is the Workflows app (Power Automate) or a Teams app with a bot sending proactive messages.
- Bot Framework SDK is no longer maintained: https://learn.microsoft.com/en-us/azure/bot-service/index-bf-sdk?view=azure-bot-service-4.0 (2026-09-01), H. Successors: Microsoft 365 Agents SDK https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/agents-sdk-overview (2026-10-16) and the Teams SDK (ex Teams AI Library v2) v2.1.0 https://learn.microsoft.com/en-us/javascript/api/teams-sdk-typescript/?view=msteams-sdk-ts-latest (2026-09-17): `@microsoft/teams.apps`, `teams.api`, `teams.cards`, `teams.graph`; `teams.ai`, `teams.mcp`, `teams.a2a` deprecated (bring your own LLM SDK). All MIT.
- Proactive messages: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages (2026-10-13), H. App must be installed in the target scope; store `conversationId`; 403 `MessageWritesBlocked` when uninstalled. An Azure Bot resource and Entra app registration are still required (M).
- Graph chatMessage POST: https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0 (2026-05-19), H. Application permission is migration-only; a service cannot post as itself via Graph. Use a bot.
- Adaptive Cards in Teams support schema up to 1.6: https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference (2026-10-23), H.
- App manifest latest GA 1.29 (June 2026); 1.30 listed as new (treat as preview): https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/?view=m365-app-1.25 (2026-10-29), H.
- Tab SSO: https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/authentication/tab-sso-overview (2026-07-22), H. Entra app with `access_as_user`, `webApplicationInfo` in manifest, TeamsJS `getAuthToken()`, OBO server-side; OAuth only, no SAML.
- Teams message change notifications: https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage (2026-04-03), H. Since 25 Aug 2025 these APIs are reported as no longer metered (M; page redirected).

Design consequence: Teams notifications ship as a Teams app with a bot (Teams SDK v2) plus a personal tab that embeds the web app with tab SSO; no reliance on incoming webhooks.

## Microsoft 365 Copilot extensibility

- Plugins overview https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugins-overview (2026-10-12), H: a plugin bundles declarative agents, Copilot connectors and MCP server references. Work IQ Dev Tools are preview.
- Agents overview https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/agents-overview (2026-09-30), H: declarative agents (manifest v1.7; Copilot Studio low-code or Agents Toolkit pro-code) vs custom engine agents.
- MCP and API plugins as actions inside declarative agents: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/overview-plugins (2026-10-28), H. Plugin manifest v2.4; MCP dynamic tool discovery needs app manifest 1.29+.
- Copilot connectors (ex Graph connectors): https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/overview-copilot-connector (2026-09-30) and https://learn.microsoft.com/en-us/graph/api/resources/connectors-api-overview?view=graph-rest-1.0 (2026-07-24), H. Synced model: `externalConnection` → `schema` → PUT `externalItem` with required `acl` (user, group, everyone, everyoneExceptGuests, externalGroup; grant or deny). Permissions `ExternalConnection.ReadWrite.OwnedBy`, `ExternalItem.ReadWrite.OwnedBy`. Limits https://learn.microsoft.com/en-us/graph/connecting-external-content-api-limits (2026-07-24): 30 MB parsed text per item, 25 concurrent ops per connection, 100k external groups per tenant. Federated (MCP) connectors: availability varies, treat as preview.

Design consequence (ADR-0007): Copilot export = synced Copilot connector pushing one `externalItem` per published content version with ACLs derived from our audience rows (Entra user/group ids where mapped; `externalGroup` for our local groups). Content with unmappable audiences is not exported. A declarative agent referencing the connection is an optional packaging step.

## Entra ID

- Multitenant OIDC: https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant (2026-06-15), H. Use `/organizations`; admin consent flow; after first sign-in use the tenant authority.
- Token validation: https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens (2026-07-17), H. Use `common/v2.0` discovery; substitute `tid` into the templated issuer and require exact match; key all tenant data by `tid`.
- SCIM endpoint requirements: https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups (2026-09-16), H. `/Users`, `/Groups` (PATCH required), `/Schemas`, `/ServiceProviderConfig`, `/ResourceTypes`; filters `userName eq`, `externalId eq`, `emails[type eq "work"].value eq`, `displayName eq`; `excludedAttributes=members`; zero results → 200 ListResponse with `totalResults: 0`; soft delete via `active=false` (user still returned); PATCH ops arrive capitalised; group PATCH may return 204.
- SCIM compatibility quirks: https://learn.microsoft.com/en-us/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility (2026-02-05), H. Without `?aadOptscim062020` Entra sends `"op":"Replace","path":"active","value":"False"` (string) and member removal with a value array; with the flag, RFC-compliant lowercase ops and `members[value eq "..."]`. Accept both.
- App Gallery listing: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/v2-howto-app-gallery-listing (2026-09-03); SSO reqs (2026-08-26); provisioning reqs (2026-08-29), H. Gallery SCIM requires OAuth client credentials or workload identity federation (no long-lived tokens), 25 req/s per tenant, schema discovery.

## SDKs (all MIT)

`@microsoft/microsoft-graph-client` (documented JS SDK, 2025-08-06), `@azure/msal-node` v5 (2026-10-23), `@microsoft/teams.*` v2.1.0, Microsoft 365 Agents SDK for JS. `botbuilder` is unmaintained.

## Retired / deprecated / preview

Retired: Office 365 connectors and incoming webhooks (May 2026); Bot Framework SDK (unmaintained). Deprecated: `teams.ai`, `teams.mcp`, `teams.a2a`; `grantedTo` (use V2). Preview: Work IQ Dev Tools, manifest 1.30, federated MCP connectors.
