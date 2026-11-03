# ADR-0010: Prompt-injection defences and model safety for the assistant

Status: proposed, 2026-11-03. Confidence: high.

## Context

Uploaded documents and transcripts are untrusted input that will be placed in model context. Indirect prompt injection (OWASP LLM01:2025) could try to exfiltrate content, change answers, or trick the user into visiting links. Authorization must never depend on the model (ADR-0002). Guidance reviewed: OWASP LLM01:2025, Microsoft Spotlighting and Prompt Shields, Anthropic guardrails guidance, OpenAI agent safety guidance (docs/research, 2026-11-03).

## Decision

1. **Authorization outside the model.** Retrieval returns only permitted chunks (SQL predicate plus post-check). The model has no tool that can read beyond that set, no write tools in the answer path (M2), and no network access.
2. **Untrusted data is labelled and encoded.** Retrieved chunks are passed as structured, JSON-encoded data blocks with provenance (`content_id`, `version`, `locator`, `title`), inside a clearly delimited "retrieved documents" section; the system prompt states that instructions inside retrieved documents are data and must be ignored. For providers that support it, chunks go into tool-result blocks rather than user text.
3. **Constrained output.** Answers are produced as a schema (`answer`, `citations[]`, `confidence`, `unanswerable`) and validated; citations must reference chunk ids present in the retrieved set (citation validator) or the answer is rejected and regenerated once, then marked low confidence.
4. **Links are untrusted.** URLs in answers are rendered only if they appear verbatim in a cited chunk and point to allowed schemes; external links show an interstitial; no auto-navigation.
5. **Content from retrieved documents never changes system behaviour**: no "memory" of instructions across turns, no tool-call generation from document text; the only follow-up actions are user-initiated (open clip at timestamp, ask follow-up).
6. **Optional screening**: a lightweight classifier pass (self-hosted small model or vendor prompt shield when policy allows) flags chunks that look like injection attempts; flagged chunks are still permitted content but are shown to the user with a warning and excluded from the model context when the org enables strict mode.
7. **Logging and red-team**: injection attempts (classifier hits, schema rejections, citation failures) are logged as security events; a CI corpus of injected documents (exfiltration, instruction override, link planting, markdown/image beacons) must produce no leaked content, no uncited links and no behaviour change.
8. **Model output hygiene**: Markdown rendering strips raw HTML, images are not auto-loaded from untrusted URLs (beacon exfiltration), code blocks are inert.
9. **Agentic features later** (M7+: expert routing, content suggestions) run as batch jobs with explicit allow-listed actions and human approval; never from an interactive injected context.

## Consequences

- Answer quality constraints (structured output, citation validation) add latency; acceptable for a knowledge assistant.
- Some providers lack tool-result blocks; the delimiter strategy still applies.

## Tests

- Injection corpus in `packages/providers/test/injection/` with expected outcomes; runs against the fake provider deterministically and against a real provider in a nightly, budgeted job.
- Citation validator rejects fabricated ids; link renderer blocks non-cited URLs; image beacons never fetched (network fake asserts zero requests).
