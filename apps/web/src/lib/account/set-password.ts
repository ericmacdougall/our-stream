// SPDX-License-Identifier: AGPL-3.0-only
// Set-password logic for POST /v1/auth/password. An account created by an invite has no password;
// the owner may choose one once. The server answers 409 `password_set` when one exists, which is a
// settled end state for the UI (also what a retry sees after a lost response that had in fact
// committed), not an error to retry. There is no reset flow, so the form must never let the person
// believe a different password was stored than the one the server kept: whenever the outcome is not
// known for certain (no response, empty-body failure, 5xx from the API or an intermediary after the
// hash may already be stored) the typed value is frozen and may only be resent unchanged or abandoned.
import { describeError } from '../errors';
import { PASSWORD_MAX, PASSWORD_MIN } from '../password';

export type NewPasswordProblem = 'tooShort' | 'tooLong' | 'mismatch';

/** Client-side check before the request: contract bounds first, then the confirm field. */
export function validateNewPassword(password: string, confirm: string): NewPasswordProblem | null {
  if (password.length < PASSWORD_MIN) return 'tooShort';
  if (password.length > PASSWORD_MAX) return 'tooLong';
  if (password !== confirm) return 'mismatch';
  return null;
}

export type SetPasswordOutcome =
  | { kind: 'set' }
  | { kind: 'alreadySet' }
  /** The request may or may not have committed; only an identical retry is safe. */
  | { kind: 'uncertain' }
  /** A definite refusal (4xx with a body): the server did not store anything. */
  | { kind: 'error'; message: string };

interface ApiResult {
  data?: unknown;
  error?: unknown;
  response?: Response | { status: number };
}

/**
 * openapi-fetch result -> what the form should show. Success is gated on a 2xx status, not on the
 * absence of an error body: openapi-fetch yields `{error: undefined}` for any empty-body response,
 * including a 502/504 from a proxy. Server message text never reaches the screen.
 */
export function resolveSetPassword(result: ApiResult): SetPasswordOutcome {
  const status = result.response?.status;
  if (status === undefined) return { kind: 'uncertain' };
  if (status >= 200 && status < 300 && result.error === undefined) return { kind: 'set' };
  const code =
    result.error && typeof result.error === 'object' && 'error' in result.error
      ? (result.error as { error?: { code?: string } }).error?.code
      : undefined;
  if (code === 'password_set' || (code === undefined && status === 409)) {
    return { kind: 'alreadySet' };
  }
  if (status >= 500 || status < 400) return { kind: 'uncertain' };
  return { kind: 'error', message: describeError(code, status) };
}

// ---- submission state machine ----
// editing -> pending -> settled | editing (definite refusal) | uncertain (outcome unknown)
// uncertain -> pending (retry, identical payload) | editing (start over, fields cleared)
export type SubmitState =
  | { phase: 'editing' }
  | { phase: 'pending'; payload: string; retried: boolean }
  | { phase: 'uncertain'; payload: string }
  /** `afterRetry`: an earlier attempt had reached the server with this very value. */
  | { phase: 'settled'; outcome: 'set' | 'alreadySet'; afterRetry: boolean };

export type SubmitEvent =
  | { type: 'submit'; password: string }
  | { type: 'response'; outcome: SetPasswordOutcome }
  | { type: 'lost' }
  | { type: 'retry' }
  | { type: 'startOver' };

export const INITIAL_SUBMIT_STATE: SubmitState = { phase: 'editing' };

export function reduceSubmit(state: SubmitState, event: SubmitEvent): SubmitState {
  switch (state.phase) {
    case 'editing':
      return event.type === 'submit'
        ? { phase: 'pending', payload: event.password, retried: false }
        : state;
    case 'pending':
      if (event.type === 'lost') return { phase: 'uncertain', payload: state.payload };
      if (event.type === 'response') {
        switch (event.outcome.kind) {
          case 'uncertain':
            return { phase: 'uncertain', payload: state.payload };
          case 'error':
            return { phase: 'editing' };
          default:
            return { phase: 'settled', outcome: event.outcome.kind, afterRetry: state.retried };
        }
      }
      return state;
    case 'uncertain':
      if (event.type === 'retry')
        return { phase: 'pending', payload: state.payload, retried: true };
      if (event.type === 'startOver') return { phase: 'editing' };
      return state;
    case 'settled':
      return state;
  }
}
