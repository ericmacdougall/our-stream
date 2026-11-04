// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  INITIAL_SUBMIT_STATE,
  reduceSubmit,
  resolveSetPassword,
  validateNewPassword,
  type SubmitState,
} from './set-password.js';

describe('validateNewPassword', () => {
  it('accepts a matching pair within the contract bounds', () => {
    expect(validateNewPassword('correct horse battery', 'correct horse battery')).toBeNull();
    const max = 'x'.repeat(256);
    expect(validateNewPassword(max, max)).toBeNull();
  });
  it('rejects a short password before anything else', () => {
    expect(validateNewPassword('short', 'short')).toBe('tooShort');
    expect(validateNewPassword('short', 'different')).toBe('tooShort');
  });
  it('rejects a password above the contract maximum instead of letting the API answer 400', () => {
    const long = 'x'.repeat(257);
    expect(validateNewPassword(long, long)).toBe('tooLong');
  });
  it('rejects a mismatch (no reset flow exists, a typo is irreversible from the product)', () => {
    expect(validateNewPassword('correct horse battery', 'correct horse batterx')).toBe('mismatch');
    expect(validateNewPassword('correct horse battery', '')).toBe('mismatch');
  });
  it('compares the exact bytes: trailing whitespace is a mismatch, not trimmed away', () => {
    expect(validateNewPassword('correct horse battery', 'correct horse battery ')).toBe('mismatch');
  });
});

describe('resolveSetPassword', () => {
  it('treats a 2xx without an error body as set', () => {
    expect(resolveSetPassword({ data: { ok: true }, response: { status: 200 } })).toEqual({
      kind: 'set',
    });
    expect(resolveSetPassword({ data: undefined, response: { status: 204 } })).toEqual({
      kind: 'set',
    });
  });
  it('never calls an empty-body non-2xx a success (openapi-fetch yields error: undefined)', () => {
    expect(resolveSetPassword({ error: undefined, response: { status: 502 } })).toEqual({
      kind: 'uncertain',
    });
    expect(resolveSetPassword({ error: '', response: { status: 504 } })).toEqual({
      kind: 'uncertain',
    });
  });
  it('treats a missing response as uncertain, not as success', () => {
    expect(resolveSetPassword({})).toEqual({ kind: 'uncertain' });
  });
  it('treats 409 password_set as already set, never as the generic conflict copy', () => {
    const outcome = resolveSetPassword({
      error: { error: { code: 'password_set', message: 'this account already has a password' } },
      response: { status: 409 },
    });
    expect(outcome).toEqual({ kind: 'alreadySet' });
  });
  it('treats a bare 409 without a code as already set too (older servers)', () => {
    expect(resolveSetPassword({ error: {}, response: { status: 409 } })).toEqual({
      kind: 'alreadySet',
    });
  });
  it('treats any 5xx as uncertain: the hash may already be stored behind the failing hop', () => {
    expect(
      resolveSetPassword({
        error: { error: { code: 'internal', message: 'x' } },
        response: { status: 500 },
      }),
    ).toEqual({ kind: 'uncertain' });
  });
  it('maps a definite 4xx refusal to a message and keeps the form', () => {
    const outcome = resolveSetPassword({
      error: { error: { code: 'csrf', message: 'x' } },
      response: { status: 403 },
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/session has expired/i);
  });
  it('never echoes the server message text (nothing from the body reaches the screen)', () => {
    const outcome = resolveSetPassword({
      error: { error: { code: 'weird_code', message: 'SECRET DETAIL' } },
      response: { status: 422 },
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).not.toContain('SECRET DETAIL');
  });
});

describe('reduceSubmit (delayed-response contract)', () => {
  const first = 'correct horse battery';
  const pending = reduceSubmit(INITIAL_SUBMIT_STATE, { type: 'submit', password: first });
  it('settles on success or 409', () => {
    expect(pending).toEqual({ phase: 'pending', payload: first, retried: false });
    expect(reduceSubmit(pending, { type: 'response', outcome: { kind: 'set' } })).toEqual({
      phase: 'settled',
      outcome: 'set',
      afterRetry: false,
    });
    expect(reduceSubmit(pending, { type: 'response', outcome: { kind: 'alreadySet' } })).toEqual({
      phase: 'settled',
      outcome: 'alreadySet',
      afterRetry: false,
    });
  });
  it('re-enables editing only after a definite refusal (the server did not commit)', () => {
    expect(
      reduceSubmit(pending, { type: 'response', outcome: { kind: 'error', message: 'm' } }),
    ).toEqual({ phase: 'editing' });
  });
  it('freezes the payload after a lost response or an uncertain answer', () => {
    expect(reduceSubmit(pending, { type: 'lost' })).toEqual({ phase: 'uncertain', payload: first });
    expect(reduceSubmit(pending, { type: 'response', outcome: { kind: 'uncertain' } })).toEqual({
      phase: 'uncertain',
      payload: first,
    });
  });
  it('retry resends exactly the first payload and remembers that it is a retry', () => {
    const uncertain = reduceSubmit(pending, { type: 'lost' });
    // An edited value cannot sneak in: submit is ignored while uncertain.
    expect(reduceSubmit(uncertain, { type: 'submit', password: 'edited to something else' })).toBe(
      uncertain,
    );
    const retried = reduceSubmit(uncertain, { type: 'retry' });
    expect(retried).toEqual({ phase: 'pending', payload: first, retried: true });
    // A 409 after a retry means the first attempt did commit this very value.
    expect(reduceSubmit(retried, { type: 'response', outcome: { kind: 'alreadySet' } })).toEqual({
      phase: 'settled',
      outcome: 'alreadySet',
      afterRetry: true,
    });
  });
  it('start over returns to editing (the component clears the fields and warns)', () => {
    const uncertain: SubmitState = { phase: 'uncertain', payload: first };
    expect(reduceSubmit(uncertain, { type: 'startOver' })).toEqual({ phase: 'editing' });
  });
  it('ignores double submits while pending and anything after settling', () => {
    expect(reduceSubmit(pending, { type: 'submit', password: 'again' })).toBe(pending);
    const settled: SubmitState = { phase: 'settled', outcome: 'set', afterRetry: false };
    expect(reduceSubmit(settled, { type: 'submit', password: first })).toBe(settled);
    expect(reduceSubmit(settled, { type: 'lost' })).toBe(settled);
  });
});
