// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { describeError, errorCodeOf, isUnavailable } from './errors';
import { strings } from '../i18n';

describe('errorCodeOf', () => {
  it('reads the stable code from an API error body', () => {
    expect(errorCodeOf({ error: { error: { code: 'comments_disabled', message: 'x' } } })).toBe(
      'comments_disabled',
    );
    expect(errorCodeOf({ error: 'nope' })).toBe('unknown');
    expect(errorCodeOf({})).toBe('unknown');
  });
});

describe('describeError', () => {
  it('maps known codes and falls back by status, never echoing the server message', () => {
    expect(describeError('comments_disabled')).toBe(strings.errors.commentsDisabled);
    expect(describeError('invalid_credentials')).toBe(strings.errors.invalidCredentials);
    expect(describeError('weird_code', 429)).toBe(strings.errors.rateLimited);
    expect(describeError('weird_code', 503)).toBe(strings.errors.generic);
    expect(describeError(undefined)).toBe(strings.errors.generic);
  });
});

describe('isUnavailable', () => {
  it('treats 404 content_not_found and retracted as "no longer available"', () => {
    expect(isUnavailable('content_not_found', 404)).toBe(true);
    expect(isUnavailable('retracted', 409)).toBe(true);
    expect(isUnavailable('unknown', 404)).toBe(true);
    expect(isUnavailable('rate_limited', 429)).toBe(false);
    expect(isUnavailable('unknown', 500)).toBe(false);
  });
});
