// SPDX-License-Identifier: AGPL-3.0-only
// Retrieval limits and index settings (M2a spec, "Retrieval limits"). They are fixed in code so the EXPLAIN
// and recall tests run with exactly the values production uses; tests may override them only through the
// `tuning` seam of the engine.

/** `k` above this is a 400 (request validation). */
export const K_MAX = 50;
export const K_DEFAULT = 10;
/** Query text length cap in UTF-16 code units (request validation, 400 above). */
export const QUERY_MAX_CHARS = 2000;
/** Each leg fetches this many times k candidates before fusion. */
export const OVERFETCH = 4;

/** Approximate-leg settings (pgvector 0.8 iterative scan). Recorded in docs/documents.md. */
export const HNSW_EF_SEARCH = 100;
export const HNSW_MAX_SCAN_TUPLES = 20_000;
export const HNSW_ITERATIVE_SCAN = 'relaxed_order';

/** Exact-scan fallback: runs in a SAVEPOINT with this statement timeout and candidate-row cap. */
export const FALLBACK_TIMEOUT_MS = 200;
export const FALLBACK_ROW_CAP = 20_000;
/** Concurrent fallbacks per process; a full semaphore degrades to keyword_only at once. */
export const FALLBACK_CONCURRENCY = 4;

/** The query text is embedded before the tenant transaction opens, bounded by this timeout. */
export const EMBED_TIMEOUT_MS = 2000;

/** Permitted-id cache: bucket width, and the bounds of the per-process LRU (ADR-0002, M2a spec). */
export const CACHE_BUCKET_MS = 30_000;
export const CACHE_MAX_IDS_TOTAL = 200_000;
export const CACHE_MAX_IDS_PER_ENTRY = 5_000;

/** Characters of chunk text returned as the snippet. */
export const SNIPPET_CHARS = 300;

/** Reciprocal-rank-fusion constant. */
export const RRF_K = 60;

/** Per-user request budget shared with keyword search (spec: 60 per user per minute). */
export const RETRIEVAL_RATE_LIMIT_PER_MINUTE = 60;
