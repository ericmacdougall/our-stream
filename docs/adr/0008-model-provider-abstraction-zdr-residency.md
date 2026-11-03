# ADR-0008: Model-provider abstraction with ZDR and data-residency policy

Status: proposed, 2026-11-03. Confidence: high.

## Context

ASR, embeddings, chat, reranking, translation, TTS and video generation each have hosted and self-hosted options with very different data-handling terms (see docs/research/2026-11-03-ai-pipeline-zdr-embeddings-parsing-pii.md). Enterprise customers need to pin regions, require zero data retention, or forbid external calls entirely. Several vendor models are deprecated on known dates (OpenAI whisper-1 and gpt-4o-transcribe 2027-02-26; OpenAI TTS 2027-01-06; Sora gone). Provider choice must be a configuration decision, auditable, and enforced in code.

## Decision

1. **Capabilities** in `packages/providers`: `asr`, `embed`, `chat`, `rerank`, `translate`, `tts`, `video`. Each has a small typed interface (inputs, outputs, streaming where relevant) and a `fake` implementation.
2. **Provider descriptor** (static metadata shipped with each adapter, reviewed against vendor docs with a date):
   ```ts
   { id, vendor, capability, models: [{ id, dims?, maxInput, languages, deprecatedOn? }],
     regions: ['us','eu',...], retentionClass: 'self_hosted'|'zdr_contractual'|'default_retention'|'trains_by_default',
     trainingUse: 'never'|'opt_out'|'default_on', requiresContract: boolean, residencyNotes, sourceUrl, verifiedOn }
   ```
3. **Org model policy**: `allowedVendors[]`, `allowedRegions[]`, `requireZdr: boolean`, `selfHostOnly: boolean`, `allowTrainingUse: false` (fixed), per-capability overrides, and an acknowledgement field for contractual flags ("we have ZDR with OpenAI", set by an admin, audited). The router refuses any call that violates the policy with a clear error and never silently falls back to a non-compliant provider.
4. **Routing**: per capability an ordered list of provider configs; health and quota aware; fallback only within policy. Embedding routing is pinned per index (`embedding_model`, `dims`) because vectors are not interchangeable; model changes trigger a re-embed job.
5. **Defaults**:
   - Self-host (sovereign) profile: ASR whisper.cpp or faster-whisper sidecar; embeddings Qwen3-Embedding-0.6B (1024 dims) via TEI/vLLM/Ollama; rerank bge-reranker-v2-m3; chat any OpenAI-compatible endpoint (vLLM/Ollama); TTS Kokoro; translate via chat model; video none.
   - Hosted profile: ASR Deepgram (with `mip_opt_out=true`, regional endpoint) or Azure Speech; embeddings voyage-4 or OpenAI text-embedding-3-large truncated to 1024; chat OpenAI/Anthropic/Azure OpenAI/Bedrock/Vertex/Mistral adapters; rerank Voyage/Cohere; TTS Azure or Google (ElevenLabs enterprise optional); video Veo on Vertex (optional, hosted-only, no sovereignty path).
   - Never default to free-tier Gemini API (trains on data) or deprecated OpenAI audio models.
6. **Audit and telemetry**: every model call logs org, capability, provider, model, region, retention class, token/second counts, latency and cost estimate, never prompt or content. Spend caps per org per day with alerts.
7. **Data minimisation**: only permitted chunks (ADR-0002) and the user's question are sent; no user identifiers beyond an opaque session id; no file uploads to vendor file stores (not ZDR-eligible); batch APIs are not used under `requireZdr`.
8. **Documentation**: `docs/privacy/model-providers.md` lists each vendor's retention, residency and ZDR terms with source URLs and verification dates, plus a customer checklist (confirm ZDR/MAM with the vendor, choose regional endpoints, avoid file/batch APIs).

## Consequences

- Switching between hosted and sovereign is configuration; the codebase stays vendor-neutral.
- Descriptor metadata can go stale; a CI check fails when `verifiedOn` is older than 180 days for any enabled provider in the default profiles.
- Self-host profile requires running one or two sidecars (ASR, embeddings); compose ships them as optional profiles.

## Tests

- Policy router: table-driven tests that every (policy, provider) combination either routes or refuses with the right reason; `requireZdr` never routes to `default_retention`; `selfHostOnly` never routes to a non-`self_hosted` provider; no silent fallback.
- Embedding index pin: a dims mismatch is rejected at write time.
- Audit: no content in logs (snapshot with injected canary strings).
