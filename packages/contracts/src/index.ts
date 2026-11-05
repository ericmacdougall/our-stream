// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
// Shared API contract: Zod schemas are the source of truth for the OpenAPI document emitted by the
// API; the generated types in ./generated are produced from that document for typed clients.
import { z } from 'zod';

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  checks: z.object({
    database: z.enum(['ok', 'degraded', 'down']),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const MetaResponse = z.object({
  name: z.literal('our-stream'),
  version: z.string(),
  /** AGPL §13: link to the exact source of the running version. */
  sourceUrl: z.url(),
  commit: z.string(),
});
export type MetaResponse = z.infer<typeof MetaResponse>;

export const SyncResponse = z.object({
  authzEpoch: z.number().int().nonnegative(),
  orgContentEpoch: z.number().int().nonnegative(),
  serverTime: z.iso.datetime(),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const StreamKind = z.enum(['company', 'department', 'team', 'project', 'private']);
export const ContentKind = z.enum(['clip', 'audio', 'document', 'page', 'link']);
export const ContentState = z.enum(['draft', 'published', 'retracted']);

export * from './m1a.js';
export * from './m1b.js';
export * from './m2a.js';
export type { M1aPaths, StreamMember } from './m1a-paths.js';
export type { M1bPaths } from './m1b-paths.js';
export { createClient, type ApiClient, type ApiPaths } from './client.js';
