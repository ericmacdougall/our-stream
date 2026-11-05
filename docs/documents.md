# Documents, embeddings and the document gate (M2a core)

This page describes the database layer added by migration `0013_m2a_documents_core.sql` (schema, definer
functions, grants, rollout flag and the rollback procedure) and, from "Worker pipeline" on, the worker,
parser sandbox and embedding side. API routes, the viewer and the retrieval service are separate slices and
document themselves. See ADR-0002 (the gate in the one predicate),
ADR-0003 (versions) and ADR-0013 (keyword search).

## Schema

| object                                                             | purpose                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content_version.parse_attempt uuid`                               | fence for the parse job: written by `platform_document_claim`, nulled by retract, by the replacement's upload complete, by finish and by failure. A late worker whose attempt no longer matches writes nothing.                                                                                      |
| `content_version.completed_seq bigint`                             | monotonic upload-complete counter per content (`max + 1`, written under the content lock by `document_upload_complete`), unique per `(org_id, content_id)` where not null. "Newest" is decided by this, not by `created_at`. A NULL value never counts as newest.                                    |
| `chunk.ordinal int NOT NULL` + `chunk_version_ordinal_key`         | position of a chunk inside its version, unique per `(org_id, content_version_id, ordinal)`. Added nullable, backfilled by `row_number()` over locator `start_ms` then `id`, then `SET NOT NULL`, then `UNIQUE`. No default: the `chunk_prepare` trigger assigns `max + 1` when an insert gives none. |
| `chunk.text_sha256 bytea NOT NULL`                                 | SHA-256 of the UTF-8 bytes of the NFC-normalised text, computed only by the `chunk_prepare` BEFORE INSERT / UPDATE OF text trigger (`convert_to` is not IMMUTABLE, so it cannot be a generated column). The only key that vectors use. The TypeScript hash exists only in tests.                     |
| `embedding(org_id, text_sha256, pin_id, vector vector(1024))`      | vectors keyed by text hash and pin, primary key `(org_id, text_sha256, pin_id)`, RLS enabled and forced, app role SELECT only. The column enforces 1024 dimensions. A trigger refuses a pin that is not `active` or `shadow`.                                                                        |
| `embedding_hnsw_5a7e0001`                                          | HNSW (cosine) index partial on the default pin's literal id. Queries must write the pin id as a literal into the SQL text so the planner can match it. A shadow pin's index is built by the post-migrate job as `embedding_hnsw_<first 8 hex of the pin id>` with `CREATE INDEX CONCURRENTLY`.       |
| `platform.embedding_pin(id, model, dims, state)`                   | `active` / `shadow` / `retired`; a partial unique index allows one active pin. The default pin has the fixed id `5a7e0001-0000-4000-8000-000000000001` (Qwen3-Embedding-0.6B, 1024). No grant to the app role.                                                                                       |
| `platform.embedding_pin_ready`                                     | readiness row written by the platform-owned job: index valid, coverage complete, `checked_at`. A switch needs both flags true and `checked_at` within one hour.                                                                                                                                      |
| `platform.documents_kill_switch`                                   | singleton row; `engaged` overrides every org flag.                                                                                                                                                                                                                                                   |
| `platform.documents_flag_record`, `platform.documents_hide_record` | what the rollback recorded, for the roll-forward.                                                                                                                                                                                                                                                    |

The migration also requires pgvector 0.8.0 or later (iterative index scan) and fails closed below it.

## The flag and the kill switch

`org.settings.documents_enabled` (a JSON boolean) is the org flag. An absent key, or any value other than `true`, means off. Org creation, the settings route and the startup reconcile are API work; the database offers `platform_documents_flag_init_missing(default)` for the reconcile. `platform_documents_enabled(org)` returns `NOT kill_switch AND flag`; it asserts that `org` equals the tenant context (`app_org()`), so a caller can only ask about its own org. Worker-side definer functions use the unchecked internal `documents_enabled_unchecked(org)`.

Changing the flag (any path) or the kill switch advances the org content epoch through `org_epoch_advance`, so cached id sets are never reused across it.

With the flag off: `content_publish` refuses a draft-to-published transition of a document (`content_publish: feature_disabled: ...`, which the API maps to 403 `feature_disabled`); a published document is invisible through every `readerVisible` caller; `platform_document_finish` does not announce; embedding functions return nothing. Re-publishing an already published document, retraction, expiry and clips are unaffected.

## Document version lifecycle (all in the database)

Lock order everywhere: the `content` row first, then the `content_version` row.

| function                                                             | role     | behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document_upload_complete(content, version) -> bigint`               | app      | under the content lock: requires a document, not retracted, the version `uploaded` and still `awaiting_upload`; sets `processing_step = 'uploaded'` and `completed_seq`; rotates every other completed non-terminal version (`parse_attempt` NULL, `failed` with reason `superseded`). A version still awaiting upload (an abandoned replace init) is never rotated.                                                                                                                                                                                                                                                                                                                                                                     |
| `platform_document_claim(org, version) -> uuid`                      | platform | atomic claim; returns a fresh attempt (replacing any earlier one, which fences a dead worker) or NULL when refused (not uploaded/processing, still awaiting upload, retracted, not a document). A refused claim is acknowledged by the worker without retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `platform_document_step(org, version, attempt, step, error) -> text` | platform | attempt-guarded; `'ok'` or `'stale'`. A NULL or non-matching attempt and every terminal status are stale. A non-null error marks the version `failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `platform_document_fail(org, version, reason) -> boolean`            | platform | for refusals without an attempt (attestation unavailable, reaper); only while `uploaded` or `processing` and not awaiting upload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `platform_document_finish(org, version, attempt, chunks) -> text`    | platform | `'ok'`, `'stale'` or `'failed'`. One transaction: stale when the attempt does not match, the content is retracted, the version is no longer uploaded/processing, or a later `completed_seq` exists (then it fails its own version with `superseded`). Otherwise inserts the chunks (ordinals follow array order), switches the version to `current`, supersedes the previous current one, sets `content.current_version_id`, advances the org epoch and announces `content.published` once (same dedupe as migration 0004) when the document is published, live and the flag is on. Empty or whitespace-only chunks, no chunks and oversize chunks (over 8,000 characters or 20,000 chunks) fail the version (`no_text`, `chunk_limit`). |
| `content_publish`, `content_retract` (redefined)                     | app      | publish keeps migration 0011's millisecond truncation and adds the document guard; retract also nulls `parse_attempt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `platform_version_update` (redefined from 0004)                      | platform | for documents only a failure write is accepted, and only while uploaded or processing; every other write is a silent no-op, so a previous-build worker can never move a document version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `search_index_version` (redefined from 0009)                         | internal | returns 0 for documents (it would delete the chunks a parse wrote); sets `ordinal` and `text_sha256` for transcript chunks. `platform_search_reindex` skips documents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `platform_content_kind(org, content) -> text`                        | platform | lookup for `dispatchEvent` routing (document versions go to the document queue, clips to `media.process`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`platform_search_prune` is unchanged: chunks are inserted in the same transaction that makes a version `current`, so prune (which deletes chunks of non-current versions) cannot remove a live document's chunks.

### Visibility copies

`platform_audience_of_content`, `platform_digest_items` and `platform_viewers_of_version` carry the document clause. For viewers a document needs the flag on and a version that was current at some point (`current`, `superseded`, `retracted`), so a retraction notice still reaches the people who had opened it. `packages/authz/src/gate-enumeration.test.ts` fails when another function copies the rule.

## Embedding functions

All worker-side functions are granted to `ourstream_platform` only and are not on the app allow-list (a lint assertion fails otherwise). Text never travels in job payloads: the worker asks `platform_embedding_chunk_text` for it.

| function                                                            | behaviour                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform_embedding_active_pin() -> (id, model, dims)`              | app and platform; the only pin read the app role has.                                                                                            |
| `platform_embedding_missing_hashes(org, version, pin)`              | distinct hashes of the version's chunks without a vector under the pin; empty hashes ignored; nothing while documents are off.                   |
| `platform_embedding_reconcile(org, pin, limit)`                     | the org-wide missing-vector scan over current versions (repairs a vector lost to a concurrent garbage collection).                               |
| `platform_embedding_chunk_text(org, hashes[])`                      | text for up to 200 hashes, current versions only.                                                                                                |
| `platform_embedding_upsert(org, hash, pin, vector) -> boolean`      | refuses zero vectors, wrong dimensions, a pin that is not active or shadow, and hashes no chunk of the org references; `ON CONFLICT DO NOTHING`. |
| `platform_embedding_gc(org) -> int`                                 | removes vectors no chunk references; takes an exclusive advisory lock that waits for in-flight `platform_document_finish` transactions.          |
| `platform_embedding_coverage(org, pin) -> (total, covered)`         | per-org coverage for the readiness job, which loops over orgs (an org with documents disabled counts as 0 of 0).                                 |
| `platform_embedding_pin_register(model, dims) -> uuid`              | registers a shadow pin (1024 dimensions only).                                                                                                   |
| `platform_embedding_pin_ready(pin, index_valid, coverage_complete)` | writes the readiness row. Coverage tolerance: zero chunk hashes of current versions without a vector.                                            |
| `platform_embedding_pin_switch(pin)`                                | refuses unless the target is a shadow pin with a fresh ready row; demotes the old active pin to shadow, then promotes the target.                |
| `platform_embedding_pin_retire(pin)`                                | shadow pins only: removes its vectors (all orgs) and drops its HNSW index. A retired pin is never switched back to; register a new shadow pin.   |

## Definer function inventory and grants

App role (`APP_ALLOWED_FUNCTIONS` in `packages/db/src/schema-lint.ts`): `platform_documents_enabled`, `platform_documents_kill_switch_engaged`, `platform_embedding_active_pin`, `document_upload_complete`, plus the existing `content_publish` and `content_retract`.

Platform role only (`PLATFORM_ONLY_FUNCTIONS`): the document lifecycle functions, `platform_content_kind`, every `platform_embedding_*` function except the active-pin read, and the operator functions `platform_documents_kill_switch_set`, `platform_documents_flag_init_missing`, `platform_documents_flag_set_all`, `platform_documents_flag_restore_all`, `platform_documents_hide`, `platform_documents_restore`.

Nobody (internal helpers and triggers): `documents_enabled_unchecked`, `document_mark_failed`, `chunk_prepare`, `embedding_check_pin`, `org_documents_flag_changed`.

## Rollback procedure (SQL steps, executed once on dev2 under AC-8)

Run as the platform role. Record each step's result.

0. Engage the kill switch: `SELECT platform_documents_kill_switch_set(true);` Every query's gate is false from the next request, the org flag cannot override it, and every org's epoch advances.
1. Record and clear every org's flag: `SELECT platform_documents_flag_set_all(false);` The prior values (including "absent") go to `platform.documents_flag_record`; a repeat keeps the first record.
2. Hide documents that were published: `SELECT platform_documents_hide();` Published and scheduled documents (`state = 'published'`, even with a future `publish_at`) move to `draft`; only those rows are recorded in `platform.documents_hide_record` with their prior `publish_at`, `expires_at` and the post-hide `updated_at`. Draft documents are never recorded. Retracted documents are untouched (retraction is terminal and is not used). Delivered notification rows remain with their content id.
3. Drain or quarantine queued document jobs, then stop the parser service.
4. Deploy the previous API and worker build. The migration stays applied: `content_publish` still refuses a draft document while the flag is off; `platform_version_update` writes nothing but a failure for documents; `search_index_version` keeps clip indexing working. Accepted cost: an old-build upload of a real media file into a document runs a full transcode whose every write is a no-op, and the version stays `uploaded` (owner-only draft).
5. Check: no document reachable through any reader path, clip upload, index and search work.

Roll-forward order: deploy the new build, clear the kill switch (`platform_documents_kill_switch_set(false)`), restore the recorded flags (`platform_documents_flag_restore_all()`, which overwrites any admin change made after the switch cleared; accepted), then restore documents (`SELECT * FROM platform_documents_restore();`). Restore touches only recorded rows that are still `draft`, not retracted and whose `updated_at` equals the recorded value; the others are reported (`skipped_modified`, `skipped_retracted`, `skipped_not_draft`). It re-emits `content.published` for a live document's current version (the notification layer dedupes by `published:<versionId>`, so nobody is notified twice) and `content.scheduled` / `content.expiry_scheduled` for a future schedule, bypasses the `content_publish` guard and is idempotent. Both hide and restore write one `audit_event` per org and advance the org epoch.

## Worker pipeline (M2a worker slice)

`dispatchEvent` routes `content.version_uploaded` by content kind through `platform_content_kind(org, content)`
(the outbox runs on the platform client with no tenant context, so the kind comes from a definer function):
`document` versions go to the `document.process` queue (singleton key `doc:<version>`) and never to
`media.process`; every other kind (clip, audio, unknown content, which `media.process` then drops) goes to
`media.process` and never to the document queue. Both directions are tested.

`document.process` (`apps/worker/src/documents/process.ts`) runs in this order, and the order is the contract:

1. `platform_version_brief`: a version that does not belong to the org and content, or is no longer
   `uploaded`/`processing`, is acknowledged and dropped. The worker sees the stored MIME type only (the brief
   has no file name), so the API must store the canonical allow-listed type per extension (`application/pdf`,
   the three OOXML types, `text/csv`, `text/markdown`); `text/plain` and `application/csv` are ambiguous and
   fail the version with `parse_failed:unsupported` rather than being guessed.
2. Refusals that no retry can fix (no original, unsupported type) end the version `failed` through
   `platform_document_fail` before any claim exists.
3. **Attestation**: the parser sandbox must present a fresh heartbeat and answer a live challenge (below). When
   it cannot, the job throws and pg-boss retries (3 retries, exponential backoff from 30 s); on the last retry the
   version ends `failed` through `platform_document_fail` (`parse_failed:parser_unavailable`). Nothing is claimed
   while the sandbox is not attested.
4. **Claim**: `platform_document_claim` returns the attempt id, or NULL when the claim is refused (already
   current, failed, retracted, awaiting upload, not a document): the job is acknowledged without retry. Every
   later write carries the attempt, so a dead or replaced worker is fenced by the database (a kill after the
   claim is retried and reclaims with a fresh attempt; the old attempt's late finish returns `stale`).
5. Download (cap: 100 MiB, `parse_failed:file_too_large` beyond it), then **parse** in the sandbox. A refusal
   from the parser, a parser timeout or output that breaks the contract fails the version with a neutral
   `parse_failed:<code>` through `platform_document_step`. Errors that are not a verdict about the file (storage,
   filesystem, a busy slot) are rethrown and retried.
6. Chunk (below), then `platform_document_finish`, which writes the chunks and makes the version current in one
   transaction (or answers `stale`/`failed`). On `ok` an `embed.version` job is enqueued (ids only).

Neutral failure codes stored in `content_version.processing_error` as `parse_failed:<code>`: `file_too_large`,
`ooxml_too_large`, `ooxml_ratio`, `pdf_pages`, `text_too_large`, `cell_limit`, `csv_line`, `wall_time`,
`memory`, `spoofed_type`, `password_protected`, `macro_enabled`, `unsafe_path`, `xml_dtd`, `nul_bytes`, `no_text`,
`malformed`, `unsupported`, `block_limit`, `timeout`, `output_invalid`, `parser_unavailable`. None carries file
content.

Chunk locators stored in `chunk.locator` (jsonb; keys appear in this order, absent keys are omitted):
`page` (PDF), `slide` (PPTX), `sheet` + `rowStart` + `rowEnd` (XLSX), `rowStart` + `rowEnd` (CSV), `heading`
(DOCX and Markdown: the heading path, `A > B`, nearest headings by level). Row ranges are 1-based and disjoint.
Text kinds also carry the content language's primary subtag in `chunk.lang` (default `en`).

### Chunking

`packages/documents/src/chunk.ts`, deterministic and total. Target 800 characters, overlap 100, never above the
target (the database limit is 8,000). A chunk never spans a page, slide or sheet. A heading flushes the open
chunk, is prepended to the next paragraph when both fit, and resets the overlap. Paragraphs join with a blank
line; at the target the next chunk starts with the last 100 characters or fewer of the flushed one, cut at a word
boundary (dropped when it would push the first paragraph over the target). A paragraph longer than the target is
cut into windows at whitespace with the same overlap. Spreadsheet and CSV rows join with a newline into disjoint
row ranges with no overlap (so a range is exact); a single row longer than the target is windowed. Lone UTF-16
surrogates are made well-formed (`toWellFormed`) before the text reaches jsonb. Zero text is `no_text`.
Chunk hashes are computed only by the database trigger; the TypeScript hash exists in tests, which cross-check
new code points, decomposed text and repaired surrogates against the SQL value.

### Hidden-text rule

OOXML: tracked-change deletions and comments are excluded (mammoth omits them); hidden and very hidden sheets are
skipped; hidden slides are blanked and notes parts removed from the copy handed to officeparser, so the result
does not depend on how that library numbers slides; speaker notes never reach the index. Text hidden by other
means (Word's `w:vanish`, white-on-white text) is not detected. PDF: the text layer is extracted as it is;
invisible or off-page text cannot be detected reliably (documented limit). Formulas are never evaluated or
echoed (only a plain cached result is indexed) and external links are never followed.

## Parser sandbox

Untrusted files are parsed in a dedicated `parser` service (`apps/parser`) and nowhere else. The worker only
copies bytes in and reads a schema-checked result out.

**Isolation, enforced by the runtime and not by the application.** Compose: `network_mode: none`, read-only root
filesystem, tmpfs `/tmp` (256 MiB), non-root `1000:1000`, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`
128, `mem_limit` 1 GiB, and an environment of exactly two directory variables (it deliberately does not use the
shared app environment, so no secret is mounted). Helm: a Deployment with `runAsNonRoot`, read-only root,
no ServiceAccount token, memory-backed `/tmp`, 1 GiB limit, no Secret references, one replica (one job slot per
pod), and a `NetworkPolicy` with `policyTypes: [Ingress, Egress]` and no rules (deny-all in both directions),
always rendered with the parser. Kubernetes has no per-pod pid limit: set the kubelet `podPidsLimit` on the node
pool. The CNI must enforce NetworkPolicy (kindnet and plain flannel do not); the self-test below is what notices
a CNI that does not.

**Exchange by files, no sockets.** Two volumes are shared with the worker: the job slot (`/slot`) and the control
directory (`/ctl`). The parser exposes no port.

| file                          | writer | meaning                                                                                                  |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `/ctl/heartbeat.json`         | parser | every 2 s, atomically: per-start random nonce, timestamp, and the self-test result                       |
| `/ctl/challenge-<id>.json`    | worker | a random id per attestation                                                                              |
| `/ctl/response-<id>.json`     | parser | `{id, nonce, selfTestOk}`, written only by the live process that knows its nonce                         |
| `/slot/.claim`                | worker | exclusive lock of the slot (O_EXCL; stale after wall limit + 80 s); a second worker replica waits for it |
| `/slot/input.bin`, `job.json` | worker | the one original, then the job file written last and atomically (the parser starts when it appears)      |
| `/slot/result.json`           | parser | `{ok: true, kind, pages?, blocks[]}` or `{ok: false, code}`                                              |

**Attestation** (worker, before every claim): the heartbeat must be younger than 15 s (`PARSER_HEARTBEAT_TTL_MS`),
its self-test must report network blocked, root filesystem read-only, non-root and no secret-like environment, and
the parser must answer a fresh random challenge with the same nonce. A stale file, a forged static file (nothing
answers the challenge) or a stopped parser fails closed. It is a misconfiguration check only: a compromised parser
can answer. The worker therefore trusts nothing from the parser beyond the validated result.

**Self-test** (identical under compose and Kubernetes, `apps/parser/src/selftest.ts`): outbound TCP to three public
addresses and a DNS lookup must all fail; the root mount must be `ro` in `/proc/self/mountinfo`; uid must not be
0; no environment variable may look like a credential.

**One job at a time, one file in the slot.** The worker copies exactly one original into the slot after wiping
whatever it finds there, and wipes it again after the job whatever the outcome (success, refusal, timeout,
invalid output), so a parser never sees another job's original or output. A canary file from a previous job is
asserted unreadable and absent from the next result, in the unit suite and inside the real container.

**Untrusted output.** `result.json` is opened with `O_NOFOLLOW`, must be a regular file directly under the slot
(a symlink, FIFO or directory is refused, even a symlink to a valid result for the right job), at most 32 MiB,
schema-validated, bound to this job's random id, with no NUL in any text, total text within the budget and the
block count capped. Any breach fails the version with `parse_failed:output_invalid` and is not retried.

**Limits** (NEG-1; defaults are owner-chosen, `packages/documents/src/limits.ts`, and the parser clamps a job file
to them, so a forged job cannot raise a budget): file 100 MiB; OOXML uncompressed 500 MB (500 MiB) and ratio 200,
checked on the central directory and then on the real inflated byte count of every entry (a lying header is caught
by the count); PDF 500 pages; extracted text 5 MiB; XLSX 1,000,000 cells streamed; CSV line 1 MiB; wall 120 s per
job (the extraction thread is terminated); V8 heap 640 MiB for the extraction thread (never pass `--max-old-space-size` to the parser process: it silently overrides the thread's cap, which the runtime suite found), below the 1 GiB container
cgroup, which is the outer wall for memory the heap limit does not see (a job killed that way produces no result
and ends `parse_failed:timeout`; the container restarts). Every OOXML package is also checked for encrypted entries,
zip64, entry names that escape the package (`../`, absolute, drive letters, backslashes, NUL), `vbaProject.bin` or
a macro-enabled content type, a DTD or entity declaration in any XML part (UTF-16/32 XML is refused because it
would hide one from the scan), and the main part must match the declared kind. Encrypted PDFs, OLE-wrapped
password-protected Office files, extension and MIME spoofing, NUL bytes and zero text each end with their own
neutral code. CSV and Markdown decode as UTF-8, falling back to windows-1252 for legacy exports, with BOM handling.

Parsers (ADR-0003 tier 1): pdfjs-dist (legacy build, no scripting, no eval, no fonts; embedded JavaScript is never
executed), mammoth, officeparser (PPTX), exceljs streaming reader (XLSX; it loses worksheets silently when the
package lists shared strings after the worksheets, so the parser compares the sheets it read with `workbook.xml`
and refuses the file rather than index part of it). `pnpm licenses:check` passes: the `unzipper` dependency of
exceljs is overridden to 0.12.5 (0.10 pulled the unlicensed `buffers` package), jszip is dual-licensed and the MIT
terms are elected, and `duck@0.1.12` ships the BSD 2-clause text.

**How CI proves it.** `apps/parser/src/extract.test.ts` and `runner.test.ts` run the real parsers (golden chunks per
kind, hidden-text fixtures, one fixture per NEG-1 case with scaled limits, the thread runner's wall and heap caps).
`packages/documents/src/parser-client.test.ts` covers attestation (fresh, missing, stale, failed self-test, forged
static heartbeat, wrong nonce), the one-file slot and untrusted output against a scripted sandbox.
`apps/parser/src/runtime.integration.ts` (`PARSER_RUNTIME=compose`) takes the `parser` service exactly as
`docker compose config` renders it and runs it: `docker inspect` of every setting above, probes inside the running
container (connect out, DNS, write the root, see the worker's files, uid), a real 1.5 GiB allocation killed by the
memory cgroup, one full-size fixture per NEG-1 case with a wall-clock budget (a real 520 MiB bomb, 501 pages,
a 101 MiB file, more than 1,000,000 XLSX cells, a CSV line over 1 MiB, ...), after each of which the same container
must still be running (same start time, restart count 0), a canary across two jobs, a hostile parser container
(same sandbox configuration; answers attestation like a compromised parser and then writes a symlink, FIFO,
directory, oversize file, wrong job id or garbage), two misconfigured copies of the sandbox (one without `network_mode: none`, one with a writable root) whose self-test reports it and which the worker refuses to attest, and a stopped parser that the worker refuses until it is back.
The Helm side is `infra/helm/our-stream/ci/check.sh` (deny-all policy and parser pod invariants with failing
controls) and `infra/docker/check-compose.py` (the compose invariants, with failing controls in the evidence).
The suite builds the image from `parser.Dockerfile` by default; set `PARSER_TEST_BUNDLE` to run the identical
service config on `node:24-bookworm-slim` with a `pnpm deploy` bundle mounted (used where an image build is too slow).

## Embeddings (M2a worker slice)

**Model and service.** The default pin is Qwen3-Embedding-0.6B (Apache-2.0, 1024 dimensions), served by Hugging Face
text-embeddings-inference (Apache-2.0) on its OpenAI-compatible `POST /v1/embeddings`. Compose: profile
`embeddings` (`ghcr.io/huggingface/text-embeddings-inference:cpu-1.8` by digest, model revision pinned); Helm:
`embeddings.enabled`. Select it with `EMBED_PROVIDER=qwen-http` (`EMBED_MODEL`, `EMBED_URL`, `EMBED_TIMEOUT_MS`).
`EMBED_PROVIDER=fake` is the CI and evaluation default: a deterministic bag-of-words vector that never emits a zero
vector, reports the default pin's model name, is not semantic and is refused by the worker when
`NODE_ENV=production` unless `EMBED_ALLOW_FAKE_IN_PRODUCTION=true`. A same-dimension model swap uses
`EMBED_SHADOW_PROVIDER` / `EMBED_SHADOW_MODEL` / `EMBED_SHADOW_URL` for the shadow pin's provider. Model and server
licences were read on 2026-11-04 (Hugging Face model card and GitHub licence API) and the images are on the
licence review list; the service definitions have not been run against a live model download in this repository.

**Policy.** The only `EmbedProvider.embed` call site in the worker is `documents/embed.ts`, reached through
`selectProvider(policy, [the provider whose model equals the pin's model], 'embed')`. With one candidate the router
can refuse but never substitute: under the default `selfHostOnly` a hosted embedder is refused, nothing is written,
and retrieval stays keyword-only for that text. A static scan test fails if another call site appears.

**Jobs.** No chunk text, title or hash travels in a payload or a log; errors carry fixed codes
(`embed job failed: <code>`), and a provider error that echoes its input is replaced before it leaves the function.

| queue             | payload                                    | effect                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `embed.version`   | `{orgId, versionId}`                       | `platform_embedding_missing_hashes` for the active pin, `platform_embedding_chunk_text`, embed in batches of 16, `platform_embedding_upsert`. Unchanged text (a replacement version, a re-run) has no missing hashes: zero calls                                                                                                     |
| `embed.reconcile` | none, cron `EMBED_RECONCILE_CRON` (10 min) | per org: `platform_embedding_gc`, then the `platform_embedding_reconcile` scan and embed, then per-org readiness (`platform_embedding_coverage`, logged). Repairs a vector lost to a concurrent collection and backfills existing clip chunks; nothing runs for an org with documents disabled, so the backfill pauses with the flag |
| `embed.pin`       | `{action, pinId, model, switch?}`          | `fill` (every org, under the shadow pin), `ready` (index VALID + coverage, writes `platform_embedding_pin_ready`), `switch`, or `advance` (fill, ready, then switch only when ready)                                                                                                                                                 |

Per-org backfill readiness is the `embed.reconcile` log line and report (`total`, `covered`, `ready`); there is no
table for it (no core change was made), and retrieval does not need one because a chunk without a vector takes part
in the keyword leg only.

**Pins.** `pin-cli` (`node dist/pin-cli.js`): `ensure` is the post-migrate index job (compose `pin-index` service,
Helm `pin-index` hook Job, the only workloads besides `migrate` that see the admin URL): for every pin that is not
retired it runs `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (`packages/db/src/pin-index.ts`, an INVALID leftover is
dropped and rebuilt), writes readiness and exits non-zero if an index is invalid; it is idempotent. `register
<model>` registers a shadow pin; `status` prints pins and readiness. Model swap, in order: `register`, `ensure` (builds
the shadow index), send `embed.pin {action:'advance', pinId, model, switch:true}` (the worker fills the shadow pin
while retrieval stays on the active pin, writes readiness, switches), later retire the old pin. The database refuses
the switch unless the readiness row is fresh with a valid index and complete coverage. pgvector: compose pins
`pgvector/pgvector:0.8.7-pg17` by digest; CloudNativePG needs an image shipping the same release
(`postgresql.cloudnativepg.pgvectorVersion`, checked by the schema and recorded as an annotation); the worker
checks the installed version at start and exits when it is below 0.8.0.

## Worker rollback

The worker needs no data rollback: its writes are the migration 0013 functions, which stay applied. To roll the
worker back: (1) set the kill switch and flags and hide documents as in the database rollback procedure above;
(2) stop sending document jobs by stopping the new worker (queued `document.process`, `embed.*` jobs stay in pg-boss
and are harmless: a refused claim is acknowledged, and embedding functions return nothing while documents are
off); (3) stop the `parser` service; (4) deploy the previous worker. The previous worker routes every
`content.version_uploaded` to `media.process`: for a document it runs a transcode whose every write is a no-op
(`platform_version_update` accepts only a failure write for documents) and the version stays `uploaded`, as the
rollback section describes. Vectors stay in `embedding` (unreachable through `readerVisible`) and are garbage-collected
by the next new worker's `embed.reconcile`. Roll forward: deploy the new worker and parser, run `pin-cli ensure`,
then restore flags and documents as in the roll-forward order above; missing vectors are filled by the first
reconcile run.
