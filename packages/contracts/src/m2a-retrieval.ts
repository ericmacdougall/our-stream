// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
// M2a internal retrieval service contract (POST /v1/retrieval/query). Authorization is the SQL predicate
// plus an independent reference post-check in the API; nothing here carries chunk text beyond the snippet.
import { z } from 'zod';

export const RETRIEVAL_K_MAX = 50;
export const RETRIEVAL_QUERY_MAX_CHARS = 2000;

export const RetrievalQuery = z.object({
  q: z.string().max(RETRIEVAL_QUERY_MAX_CHARS),
  k: z.number().int().min(1).max(RETRIEVAL_K_MAX).default(10),
});
export type RetrievalQuery = z.infer<typeof RetrievalQuery>;

export const RetrievalDegradedReason = z.enum([
  'embed_unavailable',
  'embed_timeout',
  'embed_refused',
  'pin_mismatch',
  'fallback_busy',
  'fallback_timeout',
  'fallback_cap',
  'vector_unavailable',
]);

export const RetrievalChunk = z.object({
  chunkId: z.uuid(),
  contentId: z.uuid(),
  versionId: z.uuid(),
  kind: z.enum(['clip', 'audio', 'document']),
  /** Where in the source the chunk sits: PDF page, slide, sheet and rows, heading, or transcript time. */
  locator: z.record(z.string(), z.unknown()),
  snippet: z.string(),
  score: z.number(),
});

export const RetrievalResponse = z.object({
  items: z.array(RetrievalChunk),
  /** keyword_only when the vector leg was not used (see `degraded`); hybrid otherwise. */
  retrievalMode: z.enum(['hybrid', 'keyword_only']),
  /** Why the vector leg was skipped, or null. The response is still HTTP 200. */
  degraded: RetrievalDegradedReason.nullable(),
});
export type RetrievalResponse = z.infer<typeof RetrievalResponse>;
