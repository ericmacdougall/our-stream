# ADR-0009: Optional PII and secret scanning on upload

Status: proposed, 2026-11-03. Confidence: high.

## Context

Uploads may accidentally contain credentials, API keys, personal data (national ids, health data) or customer records. Some orgs want to warn, some to block publishing until review, some want nothing. Scanning must not itself leak data (no cloud DLP by default) and must store findings without storing the sensitive values.

## Decision

1. **Scan job** runs after `parse`/`asr` on the extracted text (and optionally on the original bytes for secret patterns) when the org enables scanning. Detectors:
   - Secrets: curated regex and entropy rules in-process (secretlint/gitleaks-style rule set, MIT), covering cloud keys, tokens, private keys, connection strings, JWTs.
   - PII: built-in regex detectors for emails, phone numbers, IBAN, credit cards (Luhn), national id formats by configured countries; optional Presidio sidecar (MIT) for NER-based names, addresses and medical terms; optional cloud DLP adapters (Google SDP, Amazon Comprehend, Azure AI Language) that are off by default and flagged as sending content to a vendor under the model policy (ADR-0008).
2. **Findings** are stored as `(content_version_id, detector, category, severity, locator, excerpt_hash, masked_preview)`; never the raw value. The uploader and stream moderators see findings with masked previews ("AKIA…XQ") and locators (page 3, 00:42-00:47).
3. **Policy** per org and per stream: `off`, `warn` (publish allowed, banner shown), `review` (publish blocked until a moderator accepts or the uploader re-uploads), `block_secrets` (secrets always block; PII warns). Compliance streams can require `review`.
4. **Remediation**: the uploader can re-upload a corrected version (new content version); captions and parsed text can be edited to redact; original bytes are never modified by the system.
5. **Scope**: scanning covers documents, transcripts, captions, titles, descriptions and comments (comments scanned synchronously with a small rule set).
6. **Audit**: scan outcomes and overrides are audit events.

## Consequences

- Zero external calls by default; detection quality for names and addresses depends on the optional sidecar.
- False positives are managed by severity levels and moderator overrides, not by lowering detection.

## Tests

- Fixture corpus with known secrets and PII in PDF, DOCX, XLSX and transcript forms; expected findings with locators; masked previews never contain the full value (property test).
- Policy matrix: each policy level produces the expected publish state.
- Negative: scanner timeouts or sidecar outages never silently allow publishing under `review`/`block_secrets` (fail closed with a clear status).
