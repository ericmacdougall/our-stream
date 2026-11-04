// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  CreateCommentRequest,
  EngagementEventRequest,
  FeedQueryM1b,
  SearchQuery,
  SetTagsRequest,
  Snippet,
} from './index.js';

describe('m1b contracts', () => {
  it('caps every page at 50 and defaults to 20', () => {
    expect(SearchQuery.parse({ q: 'budget' }).limit).toBe(20);
    expect(SearchQuery.safeParse({ q: 'budget', limit: '51' }).success).toBe(false);
    expect(SearchQuery.parse({ q: 'budget', limit: '50' }).limit).toBe(50);
    expect(SearchQuery.safeParse({ q: '' }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
  });

  it('rejects duplicate or unknown tags', () => {
    expect(SetTagsRequest.safeParse({ tags: ['training', 'training'] }).success).toBe(false);
    expect(SetTagsRequest.safeParse({ tags: ['nope'] }).success).toBe(false);
    expect(SetTagsRequest.parse({ tags: ['training', 'onboarding'] }).tags).toEqual([
      'training',
      'onboarding',
    ]);
  });

  it('coerces the pinned feed filter from its query-string form', () => {
    expect(FeedQueryM1b.parse({ pinned: 'true' }).pinned).toBe(true);
    expect(FeedQueryM1b.parse({ pinned: 'false' }).pinned).toBe(false);
    expect(FeedQueryM1b.parse({}).pinned).toBeUndefined();
    expect(FeedQueryM1b.safeParse({ pinned: 'yes' }).success).toBe(false);
  });

  it('snippet ranges are non-negative integer pairs', () => {
    expect(
      Snippet.parse({ source: 'transcript', text: 'the budget', ranges: [[4, 10]], tMs: 42000 })
        .ranges,
    ).toEqual([[4, 10]]);
    expect(
      Snippet.safeParse({ source: 'title', text: 'x', ranges: [[-1, 2]], tMs: null }).success,
    ).toBe(false);
  });

  it('bounds comment bodies and idempotency keys', () => {
    expect(CreateCommentRequest.parse({ body: 'hi' }).parentId).toBeNull();
    expect(CreateCommentRequest.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
    expect(CreateCommentRequest.safeParse({ body: 'ok', clientKey: 'k'.repeat(65) }).success).toBe(
      false,
    );
    expect(
      EngagementEventRequest.safeParse({
        versionId: '00000000-0000-4000-8000-000000000000',
        sessionKey: '',
        type: 'complete',
      }).success,
    ).toBe(false);
  });
});
