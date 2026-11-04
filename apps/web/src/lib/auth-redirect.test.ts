// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { signedInDestination } from './auth-redirect.js';

const me = { user: { id: 'u' } };

describe('signedInDestination', () => {
  it('returns null when there is no valid session, so the form renders (no redirect loop)', () => {
    expect(signedInDestination(null, '/streams')).toBeNull();
    expect(signedInDestination(undefined, undefined)).toBeNull();
  });
  it('sends a signed-in visitor home by default', () => {
    expect(signedInDestination(me, undefined)).toBe('/');
    expect(signedInDestination(me, '')).toBe('/');
  });
  it('honours a same-origin ?next target', () => {
    expect(signedInDestination(me, '/streams')).toBe('/streams');
    expect(signedInDestination(me, ['/upload', '/other'])).toBe('/upload');
  });
  it('refuses open-redirect targets exactly like the post-sign-in path does', () => {
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '/a\nb', 'x']) {
      expect(signedInDestination(me, bad), bad).toBe('/');
    }
  });
  it('never points back at an auth page (that would redirect in a circle)', () => {
    expect(signedInDestination(me, '/sign-in')).toBe('/');
    expect(signedInDestination(me, '/sign-up')).toBe('/');
    expect(signedInDestination(me, '/sign-in?next=%2Fstreams')).toBe('/');
    // Trailing slashes and letter case do not bypass the guard.
    expect(signedInDestination(me, '/sign-in/')).toBe('/');
    expect(signedInDestination(me, '/Sign-In')).toBe('/');
    expect(signedInDestination(me, '/magic//')).toBe('/');
  });
});
