# Risk table and adversarial angles

Status: v0.1, 2026-11-03. Owner: our-stream task owner. Each risk names the control and the acceptance test that proves it. Highest risks carry explicit negative acceptance cases in M0/M1.

| # | Risk | Likelihood / impact | Control | Proof |
|---|---|---|---|---|
| R1 | Cross-tenant leak via a missed `org_id` filter | medium / critical | RLS with FORCE on every tenant table, composite FKs, request-scoped tenant context, schema lint | Two-org fixture matrix on every read path with RLS on and off; schema lint in CI |
| R2 | Cross-audience leak (wrong stream, revoked group, scheduled or retracted content shown) | medium / critical | Single generated visibility predicate used by feed, search, retrieval, media; post-check before model context; reference implementation | Fixture matrix cells; retrieval subset property test; negative cases for revoke, expiry, retraction, future schedule |
| R3 | Model-decided or model-influenced authorization (prompt injection widens access) | medium / critical | Authorization only in SQL; retrieved chunks as labelled data; no tools in answer path; citation validator | Injection corpus in CI; citation validator tests |
| R4 | Media served without authorization (guessable keys, long-lived presigned URLs, playlist leaking segment URLs) | medium / high | Opaque keys, proxy with short HMAC tokens bound to user and version, playlist rewriting, key rotation on retraction | Media security tests: expired, wrong user, wrong version, retracted; bucket policy check in compose |
| R5 | Retraction does not propagate (stale cache, CDN, client, downstream export) | medium / high | Epoch keys, SQL status check on every query, CDN purge + key rotation, client sync endpoint, export delete in fan-out | Retract-while-cached tests; end-to-end retraction under 60 s |
| R6 | Notification duplicates or lost retraction alerts | medium / medium | Transactional outbox, dedupe keys, at-least-once with idempotency, DLQ | Outbox replay test; lost-access render test |
| R7 | Malicious uploads (zip bombs, malformed media, macro documents, polyglots, SVG/HTML with scripts) | medium / high | Type sniffing, size and time limits, ffmpeg/parsers in worker with resource limits, no macro execution, sandboxed sidecars, no inline rendering of untrusted HTML/SVG | Fixture corpus of hostile files; worker survives and marks versions failed |
| R8 | Untrusted links and comments (phishing, XSS) | medium / medium | Link interstitials, URL scheme allow-list, Markdown sanitisation, CSP, no raw HTML | XSS corpus in comments and titles; CSP header test |
| R9 | Account takeover (weak sessions, CSRF, magic-link replay, open redirect in SSO callbacks) | medium / high | HttpOnly Secure SameSite cookies, CSRF tokens on cookie mutations, single-use short-lived magic links, strict redirect allow-list, PKCE and state checks, rate limits | Auth negative tests; SSO callback with tampered state/nonce |
| R10 | SCIM endpoint abuse (token leak, mass deprovisioning, group membership injection) | low / high | Per-connection hashed tokens, rate limits, deprovision = deactivate, audit, dry-run preview for large deltas | Conformance suite; abuse tests |
| R11 | Unicode identity confusion (emails, usernames, stream names) | low / medium | NFKC normalisation and case folding for identifiers; confusable warning in invites | Property tests on normalisation |
| R12 | Time zones and DST in scheduling, expiry, calendar | medium / medium | Store UTC instants plus IANA zone for display; schedule evaluation in UTC; calendar renders in viewer zone | DST-boundary tests with fake clock |
| R13 | Concurrent edits and double actions (double publish, like toggles, comment resubmit, upload complete twice) | medium / medium | Idempotency keys on mutations, optimistic version checks, disabled controls while pending, server-side dedupe | Delayed-response Playwright scenario; API idempotency tests |
| R14 | Old or malformed persisted data after upgrades (schema drift, embedding model change) | medium / medium | Versioned migrations with rollback notes, index pins with dims, re-embed job, migration tests from the previous release snapshot | Migration test on seeded DB; dims mismatch rejected |
| R15 | Resource exhaustion (huge uploads, transcode storms, unbounded feed queries, SSE connections) | medium / medium | Org quotas, queue concurrency limits, pagination caps, connection limits, timeouts | Load smoke on T2 with limits asserted |
| R16 | Log and trace leakage of content, tokens or PII | medium / medium | pino redaction, no content in model-call audit, canary strings test | Snapshot test for canaries in logs |
| R17 | Accessibility failures (autoplay without pause, missing captions, keyboard traps, contrast) | medium / medium | Captions required or generated, pause control, reduced motion, focus management, axe in CI, manual screen-reader pass per milestone | axe gate; manual checklist |
| R18 | Vendor data handling drift (ZDR terms change, model deprecation) | medium / medium | Provider descriptors with verification dates; CI staleness check; policy router refuses non-compliant routes | Router table tests; staleness check |
| R19 | License contamination in a public AGPL repo | low / high | Allow-listed licenses, CI license report, AGPL components only as separate services | CI license gate |
| R20 | Secrets or private material committed | low / critical | gitleaks pre-commit and CI, synthetic fixtures only, review checklist | CI secret scan |
| R21 | Mobile token storage and SSO on device | low / high | expo-secure-store, PKCE, no client secrets, short-lived access tokens, refresh rotation | Mobile auth tests |
| R22 | Privacy of viewing data (managers seeing named viewers unexpectedly) | medium / medium | Org privacy modes with conservative default; transparency page for users | Privacy mode response-shape tests |

## Domain invariants

1. A user sees content only through an audience path that exists at query time; there is no "cached permission" that outlives its epoch.
2. Every derived artifact references exactly one content version; a version never changes after processing.
3. Retracted or superseded versions are never used for feed, search, retrieval, media or export.
4. Notifications never reveal content the recipient cannot currently view, except the title of an item they already saw.
5. Model calls receive only permitted chunks and never decide authorization.
6. Org boundaries hold in every store: Postgres, object storage, caches, queues, logs, exports.

## Assumptions to validate (tracked in docs/open-questions.md)

Privacy mode default; identity in M1; hosted region; provider keys and spend; mobile distribution model; GoodQA scope; private stream semantics; comment moderation defaults.
