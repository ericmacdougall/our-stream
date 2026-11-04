# ADR-0013: Keyword search over titles, descriptions and transcripts

Status: proposed, 2026-11-04 (M1b). Confidence: high on the permission model, medium on ranking and the window size (validate with real transcripts).

## Context

M1b lets anyone find clips by keyword over title, description, captions and transcript, with counts and snippets that open the clip at the matching timestamp (docs/roadmap.md). Every result, count and snippet must pass `readerVisible` (ADR-0002, risk R26: counts and snippets are existence oracles). Self-hosting must not need another service. M2 adds vectors on the same rows.

## Decision

1. **Postgres full-text search, no external index.** Titles and descriptions are indexed by a generated column `content.search_tsv` (`to_tsvector('simple', title || ' ' || description)`, GIN). Transcripts are indexed as rows of the M0 `chunk` table: `search_index_version(org, version)` cuts the version's `transcript.segments` into windows of at most 20 s or 400 characters, broken only at segment boundaries, and stores one `chunk` row per window with `locator = {"kind":"transcript","start_ms","end_ms"}`; `chunk.tsv` is the existing generated `simple` tsvector with its GIN index. Captions are generated from the same segments (ADR-0003), so indexing the transcript covers them; a later caption revision re-indexes the version.
2. **Index maintenance is transactional.** A trigger on `content_version` (AFTER UPDATE, `NEW.status = 'current'`) calls `search_index_version`, so the index is built in the same transaction that makes a version current, whether the worker (`platform_version_update`) or an operator did it. Retraction already marks versions `retracted`, and the search query joins `content_version.status = 'current'` (ADR-0004 §6), so stale rows can never surface; the worker's `search.prune` job deletes chunk rows of non-current versions for hygiene and `search.reindex` rebuilds an org on demand (for example after changing the window size).
3. **One query, predicate inside.** `GET /v1/search` runs one statement inside `withTenant` after reading the epochs (ADR-0004 key-read ordering): `websearch_to_tsquery('simple', :q)` (never raises on user input) matched against `content.search_tsv` or the current version's chunk rows, with `readerVisibleSql` in the `WHERE`, optional `streamId`/`tag` filters as additional `AND` terms, ordered by `ts_rank_cd` (normalisation 32, so scores are 0..1), then `publish_at`, `id`. `total` is `count(*)` over the same filtered set. Snippets come from `ts_headline` with private-use sentinel characters that the API converts into UTF-16 `ranges`; the API never returns markup (the manual warns `ts_headline` output is not HTML-safe). A transcript snippet carries `tMs = locator.start_ms` so clients can open the player at that instant.
4. **Language handling.** M1b uses the `simple` configuration (exact lexemes, no stemming, language-agnostic, deterministic). Per-language configurations (`english`, `german`, ...) chosen from `content.language` are an M2 follow-up (with the embeddings work, once real transcripts show the recall gap); they would change only the generated-column expression and the query, not the model.
5. **Pagination.** Results are cursor-paginated (limit at most 50): the cursor is the keyset `(score rounded to 6 decimals, publish_at, id)` of the last row, so paging a fixed query is stable while content does not change; `total` is reported on every page.
6. **Logging.** Search terms are personal data about what people look for; the API redacts the `q` value from the request URL in logs and never echoes it in error messages. No raw query text is persisted (the ADR-0006 `search` engagement event is not recorded in M1b).

## Consequences

- No new service; the fixture matrix proves search, counts and snippets against the reference implementation exactly like the feed.
- Window granularity bounds `tMs` precision to the window start (at most 20 s before the matched words); finer rows would multiply index size for little gain at M1 scale.
- Indexing runs in the version-current transaction: cost is one pass over the transcript (a 60-minute recording is a few hundred rows), accepted; a very long transcript would slow the worker's final update, not a user request.
- `simple` means "budgets" does not match "budget". Documented; revisit with per-language configs.

## Alternatives

- Meilisearch/Typesense/OpenSearch: another service to self-host and to keep in step with permissions; rejected for M1.
- Indexing at the segment level: precise timestamps but 10-20x the rows and noisier ranking.
- Building the index from the worker only: the test harness and operator paths would skip it; a trigger keeps the index and the version switch atomic.

## Tests

- Matrix: for every (org, user) cell of the authz fixture, search results, `total` and snippets equal the set of reader-visible items containing the term; a user who loses stream access mid-session gets nothing on the next search.
- Transcript hit returns a transcript snippet whose `tMs` is the start of the window that contains the matched segment.
- Stop-word-only and empty queries return `{items: [], total: 0}`; `websearch_to_tsquery` syntax (quotes, `or`, `-`) is accepted.
- A canary term sent as `q` never appears in the captured API log stream.
- Retraction removes the item from search on the next request without any index job.
