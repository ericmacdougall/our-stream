# Research: model-provider data handling (ZDR), ASR, TTS, video generation, embeddings, pgvector, document parsing, PII/secret scanning, prompt injection

Researched 2026-11-03 from official pages. [V] verified, [I] inference. Confidence in parentheses.

## Model providers: retention and residency

- OpenAI API, https://developers.openai.com/api/docs/guides/your-data (high). [V] No training on API data by default; abuse-monitoring logs up to 30 days. ZDR is an org-level contractual flag covering chat/completions, responses, embeddings, audio transcriptions and speech, moderations, realtime; not files, vector stores, batches, fine-tuning, conversations. Regional processing: US, EU (`eu.api.openai.com`), UAE; storage-only residency in AU, CA, JP, IN, SG, KR, GB; non-US regions need ZDR/MAM approval.
- Anthropic Claude API, https://platform.claude.com/docs/en/manage-claude/api-and-data-retention (2026-07-01) (high). [V] Default deletion within 30 days; ZDR per organization via sales for Messages and Token Counting; Batch, Files, code execution and Managed Agents excluded; some current models require 30-day retention and are not available under ZDR unless authorized. No published regional endpoint; use Bedrock EU or Vertex EU for residency.
- Azure OpenAI / Foundry, https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/openai/data-privacy (2026-05-18) (high). [V] Not used for training; automated abuse monitoring with per-geography flagged-sample store; modified abuse monitoring by Limited Access form (verify `ContentLogging=false`). Standard deployments process in the resource geography; DataZone US/EU; Global anywhere.
- AWS Bedrock, https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html (high). [V] Providers never see prompts; explicit `data_retention_mode` per Region (`none`, `default`, `aws_review`) enforceable via IAM condition `bedrock:DataRetentionMode`; some models require retention; cross-region inference stores data in the destination Region.
- Google Vertex AI, https://docs.cloud.google.com/vertex-ai/generative-ai/docs/data-governance (high). [V] Logging off by default; caching disableable; abuse-detection logging under ToS; Google Search grounding retains up to 3 days. Gemini API (AI Studio) terms https://aistudio.google.com/docs/terms (2026-03-23): unpaid tier trains on data. Use Vertex only.
- Mistral, https://docs.mistral.ai/admin/monitor-comply/zero-data-retention (medium). [V] ZDR on paid plans by request for stateless endpoints.
- Self-hosted: vLLM Apache-2.0, Ollama MIT, llama.cpp MIT (high). All expose OpenAI-compatible APIs.

Design consequence (ADR-0008): each provider adapter declares `retentionClass` (self-hosted, zdr-contractual, default-retention, trains-by-default), `regions`, `requiresContract` flags; org policy is enforced in code; docs include a per-vendor checklist ("confirm ZDR with vendor; never use Files/Batch under ZDR").

## ASR

- OpenAI, https://developers.openai.com/api/docs/guides/speech-to-text and /deprecations (high). [V] `whisper-1`, `gpt-4o-transcribe*` and `/v1/audio/translations` shut down 2027-02-26; replacements `gpt-transcribe`, `gpt-live-transcribe`; word timestamps and diarization for the replacement not documented. Do not build on the deprecated models.
- Deepgram, https://developers.deepgram.com/trust-security/your-data (high). [V] Model Improvement Program on by default; `mip_opt_out=true` per request; regional endpoints EU/AU/IN; self-hosted requires Enterprise.
- AssemblyAI, https://www.assemblyai.com/docs/data-retention-and-model-training (medium-high). [V] Audio deleted within 24-48 h; transcripts 30 days unless TTL; EU endpoint.
- Azure Speech, https://learn.microsoft.com/en-us/legal/cognitive-services/speech-service/speech-to-text/data-privacy-security (2026-03-31) (high). [V] Real-time and fast transcription store nothing at rest; speech containers run on-prem.
- Open source (licenses verified): whisper.cpp MIT; faster-whisper MIT; WhisperX BSD-2 (word alignment; pyannote diarization CC-BY-4.0, gated); NVIDIA parakeet-tdt-0.6b-v3 CC-BY-4.0 and canary-1b-v2 CC-BY-4.0.

Recommendation: self-host default whisper.cpp (CPU) or faster-whisper (GPU) via a small HTTP sidecar; hosted Deepgram with opt-out and regional endpoint, or Azure Speech. ASR adapter interface returns segments with timestamps and language.

## TTS and AI video

- OpenAI TTS models deprecated, shut down 2027-01-06; replacement via Realtime API (high). ElevenLabs zero-retention and EU residency are enterprise-only (medium-high). Azure neural TTS stores nothing for prebuilt voices (medium). Google Cloud TTS stateless (medium).
- Open source: Kokoro-82M Apache-2.0 (default self-host pick); Chatterbox MIT; Orpheus Apache-2.0 (weights gated, Llama-derived, confirm); Piper successor GPL-3.0; F5-TTS weights CC-BY-NC; Coqui XTTS CPML non-commercial. Exclude F5-TTS and XTTS.
- AI video: OpenAI Sora/Videos API shut down 2026-09-24. Google Veo 3.1 GA on Vertex (us-central1 only). Avatars (HeyGen, Synthesia) enterprise-tier with consent obligations. Treat video generation as an optional hosted-only plugin with no sovereignty path.

## Embeddings and rerankers

- OpenAI `text-embedding-3-small` (1536) and `-large` (3072) with `dimensions` truncation (high). Voyage `voyage-4` family, 1024 default, int8/binary outputs; `rerank-3`, `rerank-3-lite` (high); retention policy not found (low). Cohere Embed v5 and Rerank v5 (high). Google `gemini-embedding-2` (high). Jina v4 is non-commercial (Qwen Research License): exclude (high).
- Open weights: `Qwen/Qwen3-Embedding-0.6B` Apache-2.0 (1024-d, MRL, 32K, 100+ languages); `BAAI/bge-m3` MIT; `nomic-embed-text-v2-moe` Apache-2.0; `snowflake-arctic-embed-l-v2.0` Apache-2.0; `multilingual-e5-large-instruct` MIT. Rerankers: `bge-reranker-v2-m3` Apache-2.0, `Qwen3-Reranker-0.6B` Apache-2.0.

Recommendation: self-host default Qwen3-Embedding-0.6B at 1024 dims plus bge-reranker-v2-m3 served by TEI/vLLM/Ollama; hosted default voyage-4 or OpenAI `text-embedding-3-large` truncated to 1024 (ZDR-eligible). Store `embedding_model` and `dims` per index and force re-embed on change.

## pgvector and Postgres

- pgvector v0.8.7, PostgreSQL License, PG13-18 (high). [V] HNSW on `vector` up to 2,000 dims (`halfvec` 4,000); iterative index scans (`hnsw.iterative_scan = relaxed_order`, `hnsw.max_scan_tuples` default 20,000) because WHERE filters apply after the ANN scan; partial indexes or partitioning per tenant; hybrid search with `tsvector` + RRF is an officially documented pattern; binary quantization with re-rank.
- Postgres RLS, https://www.postgresql.org/docs/current/ddl-rowsecurity.html (high). [V] Owners bypass unless `FORCE ROW LEVEL SECURITY`; superuser and `BYPASSRLS` bypass; non-leakproof functions run after policies; FK and unique checks can act as covert channels.
- ParadeDB pg_search is AGPL-3.0 plus commercial; VectorChord dual AGPL/commercial. Postgres-native tsvector hybrid is the default.

Design consequence (ADR-0002, ADR-0003): visibility predicate in SQL, RLS as second belt with `FORCE`, iterative scans on, 1024-dim `vector` column with HNSW cosine, partial indexes per large tenant, two-stage retrieval for tiny permission sets, post-check assertion.

## Document parsing (licenses verified)

`pdfjs-dist` Apache-2.0; `unpdf` MIT; `mammoth` BSD-2; `officeparser` MIT (docx/pptx/xlsx text); `exceljs` MIT; npm `xlsx` (SheetJS) frozen at 0.18.5 with advisories, avoid; `tesseract.js` Apache-2.0. Sidecars: LibreOffice headless (MPL-2.0), Apache Tika (Apache-2.0), Docling (MIT), Unstructured library (Apache-2.0).

Recommendation: Tier 1 in-process Node parsers; Tier 2 optional Docling container for layout-heavy or scanned documents; LibreOffice headless for legacy formats and page rendering. Parsers are untrusted-input boundaries: size and time limits, no macros, zip-bomb protection, sandboxed containers.

## PII and secret scanning

Presidio MIT (Python sidecar); gitleaks MIT; secretlint MIT (Node); TruffleHog AGPL-3.0 (verification phones home, disclose). Cloud DLP: Google Sensitive Data Protection, Amazon Comprehend PII, Azure AI Language PII (2026-06-30). Cloud DLP contradicts sovereignty: opt-in only.

## Prompt injection

- OWASP LLM01:2025 https://genai.owasp.org/llmrisk/llm01-prompt-injection/ (high): constrain behaviour, validate output format deterministically, least privilege, separate and label untrusted content, adversarial testing.
- Microsoft Spotlighting (arXiv:2403.14720) and Prompt Shields (2026-08-28, document attack detection; spotlighting toggle preview).
- Anthropic https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks (high): untrusted content only in labelled tool-result blocks, JSON-encode untrusted strings, least privilege, sandboxed tools, screen tool outputs.
- OpenAI agent safety guidance (medium): untrusted data never directly drives behaviour.

Design consequence (ADR-0010): authorization in SQL before retrieval; retrieved chunks delivered as labelled, JSON-encoded data; no write tools in the answer path; schema-validated outputs; citation validator; injection corpus in CI.

## Deprecations to flag

OpenAI Sora gone; whisper-1 and gpt-4o-transcribe end 2027-02-26; tts-1 and gpt-4o-mini-tts end 2027-01-06; Azure spotlighting preview; Veo 3.1 Lite preview; Anthropic and Bedrock newest models require 30-day retention; SheetJS npm stale; rhasspy/piper archived (successor GPL-3.0).
