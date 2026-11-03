# Open product questions for the user

Status: 2026-11-03. Each item has a recommendation; work continues on independent parts meanwhile. Decisions are recorded in the decision log once answered.

| # | Question | Why it matters | Recommendation |
|---|---|---|---|
| Q1 | Viewing privacy default: may contributors and managers see named viewers for ordinary clips, or only aggregate counts? | Product and privacy stance; affects dashboards, notifications wording, works-council expectations in the EU | Default `identified_for_required_only`: named for content marked required or acknowledgement, aggregate otherwise; org admins can switch; users see what is visible about them |
| Q2 | Identity in M1: email + password + magic link (SSO in M5), or SSO from day one? | Sequencing and demo audience | Email/password + magic link in M1 with TOTP optional; SSO and SCIM in M5 |
| Q3 | Model providers and spend for M2: which API keys exist (OpenAI, Anthropic, Azure, Bedrock, Vertex, Voyage, Deepgram)? Is self-hosted-only acceptable for development on T2? | Determines the dev profile and whether any spend is needed; M1 needs none | Develop against the self-host profile (whisper.cpp, Qwen3-Embedding, an OpenAI-compatible local chat model) at zero cost; add hosted adapters with fakes in CI; ask before any paid key is used beyond $10 |
| Q4 | Hosted SaaS first region and operator: who runs it and where (US, EU)? | Residency defaults, cell design, legal pages | Design for region-pinned cells from day one; first hosted cell EU, second US; decide operator later (M9) |
| Q5 | Mobile distribution: one public app (App Store and Play) that can point to any self-hosted server via email-domain discovery, plus enterprise custom-app distribution docs? | App review, enterprise MDM, SaaS discovery | Yes: one public app with server discovery by email domain and a manual server URL; document Apple custom apps and managed Google Play for private deployments |
| Q6 | "Private/individual streams": personal notebooks (one member) and invite-only groups, both? | Data model of streams | Both via one mechanism: a private stream with members; a personal stream is created per user on demand |
| Q7 | Comments: open by default with stream moderators able to remove and users able to report; no anonymous comments; org can disable per stream? | Moderation workload and culture | Yes, as stated; mention notifications included |
| Q8 | GoodQA integration scope: file unresolved questions as GoodQA issues in a configured project and pull answers back? Anything else (chat, follow-ups)? | Adapter surface in M7 | Start with issue filing and answer pull-back; confirm API surface with the user |
| Q9 | Hosted transcoders (Mux, Cloudflare Stream) as optional adapters, with ffmpeg default? | Cost and sovereignty | Yes, optional adapters later; ffmpeg default |
| Q10 | Product name and domain: keep "our-stream" as the project name? | README, app ids, manifests | Keep `our-stream` for the repo and package scope `@our-stream/*`; brand can change later |
| Q11 | Required-content and acknowledgement: should acknowledgements be legally styled attestations (typed name, timestamp, version hash, IP) or a simple "I confirm" with version tracking? | Compliance use cases in M4 | Version-bound acknowledgement with timestamp and version hash; typed-name attestation as an org option |
| Q12 | Default org content retention (none, 2 years, 7 years) and whether raw engagement events default to 13 months | Compliance and storage | No deletion by default for content; raw events 13 months; legal hold overrides |
