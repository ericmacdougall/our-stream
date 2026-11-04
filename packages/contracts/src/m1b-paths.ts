// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
// Hand-written openapi-fetch path typings for the M1b routes, derived from the zod schemas in
// ./m1b.ts (same role and conventions as ./m1a-paths.ts; replaced by `pnpm contracts:generate`).
// Request bodies use z.input (defaults optional), responses use z.output.
import type { z } from 'zod';
import type { ErrorResponse, Ok } from './index.js';
import type {
  CommentList,
  Comment,
  ContentDetailM1b,
  ContentStats,
  CreateCommentRequest,
  EngagementEventRequest,
  EngagementResponse,
  FeedResponseM1b,
  MePreferences,
  OrgSettings,
  PinRequest,
  ReactionResponse,
  RemoveCommentRequest,
  ReportCommentRequest,
  SearchResponse,
  SetTagsRequest,
  ShareRequest,
  ShareResponse,
  StreamM1b,
  UpdateMePreferencesRequest,
  UpdateOrgSettingsRequest,
  UpdateStreamRequest,
} from './m1b.js';

type Json<T> = { content: { 'application/json': T } };
type ErrorResponses = {
  400: Json<ErrorResponse>;
  401: Json<ErrorResponse>;
  403: Json<ErrorResponse>;
  404: Json<ErrorResponse>;
  409: Json<ErrorResponse>;
  429: Json<ErrorResponse>;
};
type Op<Req, Res, Params = never> = {
  parameters: [Params] extends [never]
    ? { query?: never; header?: never; path?: never; cookie?: never }
    : Params;
  requestBody: [Req] extends [never] ? never : { content: { 'application/json': Req } };
  responses: { 200: Json<Res> } & ErrorResponses;
};
type IdPath = { path: { id: string } };
type Page = { cursor?: string; limit?: number };

export interface M1bPaths {
  '/v1/content/{id}/like': {
    post: Op<never, z.output<typeof ReactionResponse>, IdPath>;
    delete: Op<never, z.output<typeof ReactionResponse>, IdPath>;
  };
  '/v1/content/{id}/comments': {
    get: Op<never, z.output<typeof CommentList>, IdPath & { query?: Page }>;
    post: Op<z.input<typeof CreateCommentRequest>, z.output<typeof Comment>, IdPath>;
  };
  '/v1/comments/{id}/report': {
    post: Op<z.input<typeof ReportCommentRequest>, z.output<typeof Ok>, IdPath>;
  };
  '/v1/comments/{id}/remove': {
    post: Op<z.input<typeof RemoveCommentRequest>, z.output<typeof Comment>, IdPath>;
  };
  '/v1/content/{id}/share': {
    post: Op<z.input<typeof ShareRequest>, z.output<typeof ShareResponse>, IdPath>;
  };
  '/v1/search': {
    get: Op<
      never,
      z.output<typeof SearchResponse>,
      { query: Page & { q: string; streamId?: string; tag?: string } }
    >;
  };
  '/v1/content/{id}/engagement': {
    post: Op<z.input<typeof EngagementEventRequest>, z.output<typeof EngagementResponse>, IdPath>;
  };
  '/v1/content/{id}/stats': { get: Op<never, z.output<typeof ContentStats>, IdPath> };
  '/v1/content/{id}/tags': {
    put: Op<z.input<typeof SetTagsRequest>, z.output<typeof ContentDetailM1b>, IdPath>;
  };
  '/v1/content/{id}/pin': {
    post: Op<z.input<typeof PinRequest>, z.output<typeof ContentDetailM1b>, IdPath>;
    delete: Op<
      never,
      z.output<typeof ContentDetailM1b>,
      IdPath & { query?: { streamId?: string } }
    >;
  };
  '/v1/org/settings': {
    get: Op<never, z.output<typeof OrgSettings>>;
    patch: Op<z.input<typeof UpdateOrgSettingsRequest>, z.output<typeof OrgSettings>>;
  };
  '/v1/streams/{id}': {
    patch: Op<z.input<typeof UpdateStreamRequest>, z.output<typeof StreamM1b>, IdPath>;
  };
  '/v1/me/preferences': {
    get: Op<never, z.output<typeof MePreferences>>;
    patch: Op<z.input<typeof UpdateMePreferencesRequest>, z.output<typeof MePreferences>>;
  };
  /** M1b widens the feed: `tag` and `pinned` filters, and items carry tags/pinned/like/comment data. */
  '/v1/feed': {
    get: Op<
      never,
      z.output<typeof FeedResponseM1b>,
      {
        query?: Page & { streamId?: string; tag?: string; pinned?: 'true' | 'false' };
      }
    >;
  };
}
