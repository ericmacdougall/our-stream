// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { describeError, errorMessage } from './errors.js';

describe('errorMessage', () => {
  it('is null for a 2xx without an error body', () => {
    expect(errorMessage({ response: { status: 200 } })).toBeNull();
    expect(errorMessage({ error: undefined, response: { status: 204 } })).toBeNull();
  });
  it('never reads an empty-body non-2xx as success (openapi-fetch yields error: undefined)', () => {
    expect(errorMessage({ error: undefined, response: { status: 502 } })).toBe(
      describeError(undefined, 502),
    );
    expect(errorMessage({ error: undefined, response: { status: 401 } })).toMatch(/sign in again/i);
  });
  it('prefers the error code over the status', () => {
    expect(
      errorMessage({ error: { error: { code: 'slug_taken' } }, response: { status: 409 } }),
    ).toMatch(/short name is already taken/i);
  });
  it('maps unknown codes by status and never echoes server text', () => {
    const message = errorMessage({
      error: { error: { code: 'odd', message: 'SECRET' } },
      response: { status: 418 },
    });
    expect(message).not.toContain('SECRET');
    expect(message).toBe(describeError('odd', 418));
  });
});
