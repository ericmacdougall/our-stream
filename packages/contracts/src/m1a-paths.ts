// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
// Hand-written openapi-fetch path typings for the M1a routes, derived from the frozen zod schemas in
// ./m1a.ts. They let clients type-check against the contract before the API emits its OpenAPI
// document; `pnpm contracts:generate` replaces this file's role, at which point it is deleted.
// Request bodies use z.input (defaults optional), responses use z.output.
import type { z } from 'zod';
import type {
  ContentDetail,
  CreateContentRequest,
  CreateStreamRequest,
  FeedResponse,
  GrantStreamRoleRequest,
  LoginRequest,
  MagicLinkConsumeRequest,
  MagicLinkRequest,
  Me,
  MemberSummary,
  NotificationList,
  Ok,
  PublishRequest,
  SignupRequest,
  Stream,
  StreamRole,
  SetPasswordRequest,
  SwitchOrgRequest,
  UpdateContentRequest,
  UploadCompleteRequest,
  UploadInitRequest,
  UploadInitResponse,
  ViewEventRequest,
} from './m1a.js';
import type { ErrorResponse, SyncResponse } from './index.js';

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

export type StreamMember = {
  userId: string;
  displayName: string;
  role: z.output<typeof StreamRole>;
};

export interface M1aPaths {
  '/v1/auth/signup': { post: Op<z.input<typeof SignupRequest>, z.output<typeof Me>> };
  '/v1/auth/login': { post: Op<z.input<typeof LoginRequest>, z.output<typeof Me>> };
  '/v1/auth/magic-link': { post: Op<z.input<typeof MagicLinkRequest>, z.output<typeof Ok>> };
  '/v1/auth/password': { post: Op<z.input<typeof SetPasswordRequest>, z.output<typeof Ok>> };
  '/v1/auth/magic-link/consume': {
    post: Op<z.input<typeof MagicLinkConsumeRequest>, z.output<typeof Me>>;
  };
  '/v1/auth/logout': { post: Op<never, z.output<typeof Ok>> };
  '/v1/me': { get: Op<never, z.output<typeof Me>> };
  '/v1/me/org': { post: Op<z.input<typeof SwitchOrgRequest>, z.output<typeof Me>> };
  '/v1/members': { get: Op<never, { items: z.output<typeof MemberSummary>[] }> };
  '/v1/streams': {
    get: Op<never, { items: z.output<typeof Stream>[] }>;
    post: Op<z.input<typeof CreateStreamRequest>, z.output<typeof Stream>>;
  };
  '/v1/streams/{id}': { get: Op<never, z.output<typeof Stream>, IdPath> };
  '/v1/streams/{id}/members': { get: Op<never, { items: StreamMember[] }, IdPath> };
  '/v1/streams/{id}/grants': {
    post: Op<z.input<typeof GrantStreamRoleRequest>, z.output<typeof Ok>, IdPath>;
  };
  '/v1/content': {
    post: Op<z.input<typeof CreateContentRequest>, z.output<typeof ContentDetail>>;
  };
  '/v1/content/{id}': {
    get: Op<never, z.output<typeof ContentDetail>, IdPath>;
    patch: Op<z.input<typeof UpdateContentRequest>, z.output<typeof ContentDetail>, IdPath>;
  };
  '/v1/content/{id}/upload/init': {
    post: Op<z.input<typeof UploadInitRequest>, z.output<typeof UploadInitResponse>, IdPath>;
  };
  '/v1/content/{id}/upload/complete': {
    post: Op<z.input<typeof UploadCompleteRequest>, z.output<typeof ContentDetail>, IdPath>;
  };
  '/v1/content/{id}/publish': {
    post: Op<z.input<typeof PublishRequest>, z.output<typeof ContentDetail>, IdPath>;
  };
  '/v1/content/{id}/retract': { post: Op<never, z.output<typeof ContentDetail>, IdPath> };
  '/v1/content/{id}/view': {
    post: Op<z.input<typeof ViewEventRequest>, z.output<typeof Ok>, IdPath>;
  };
  '/v1/feed': {
    get: Op<
      never,
      z.output<typeof FeedResponse>,
      { query?: { cursor?: string; limit?: number; streamId?: string } }
    >;
  };
  '/v1/notifications': { get: Op<never, z.output<typeof NotificationList>> };
  '/v1/notifications/{id}/read': { post: Op<never, z.output<typeof Ok>, IdPath> };
  '/v1/sync': { get: Op<never, z.output<typeof SyncResponse>> };
}
