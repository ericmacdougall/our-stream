// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Lets an invitee (no password yet) choose one once. There is no reset flow in M1a, so a typo would
// lock the person into magic links: hence the confirm field and the show/hide toggle. A 409 from the
// server (password already set, including after a retried request that had in fact succeeded) is a
// settled end state and replaces the form, never a generic "already exists" error. Whenever the
// outcome is unknown (no response, empty-body failure, 5xx) the typed value is frozen (read-only)
// and can only be resent unchanged or abandoned with a warning, so the person can never believe a
// different password was stored than the one the server kept (see lib/account/set-password.ts).
import { useEffect, useId, useReducer, useRef, useState, type FormEvent } from 'react';
import { browserApi } from '@/lib/api/client';
import {
  INITIAL_SUBMIT_STATE,
  reduceSubmit,
  resolveSetPassword,
  validateNewPassword,
} from '@/lib/account/set-password';
import { t, type MessageId } from '@/lib/i18n';
import { PASSWORD_MAX, PASSWORD_MIN, passwordStrength } from '@/lib/password';
import { Notice } from '../Notice';

const STRENGTH_KEY: Record<ReturnType<typeof passwordStrength>, MessageId> = {
  tooShort: 'auth.password.tooShort',
  weak: 'auth.password.weak',
  fair: 'auth.password.fair',
  strong: 'auth.password.strong',
};

export function SetPasswordForm() {
  const id = useId();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [state, dispatch] = useReducer(reduceSubmit, INITIAL_SUBMIT_STATE);
  // The reducer owns the phase; this ref owns the in-flight request so a double click cannot start
  // a second one between the click and the re-render.
  const inFlight = useRef(false);
  const outcomeRef = useRef<HTMLParagraphElement>(null);

  const settled = state.phase === 'settled' ? state : null;
  const pending = state.phase === 'pending';
  const uncertain = state.phase === 'uncertain';

  // The form disappears on success; move focus to the outcome so keyboard and screen-reader users
  // are not left on a removed control.
  useEffect(() => {
    if (settled) outcomeRef.current?.focus();
  }, [settled]);

  async function send(payload: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setInfo(null);
    try {
      const result = await browserApi().POST('/v1/auth/password', { body: { password: payload } });
      const outcome = resolveSetPassword(result);
      if (outcome.kind === 'error') setError(outcome.message);
      else if (outcome.kind === 'uncertain') setError(t('account.password.uncertain'));
      else {
        setPassword('');
        setConfirm('');
      }
      dispatch({ type: 'response', outcome });
    } catch {
      // No response at all: the server may have committed. Freeze the typed value.
      setError(t('account.password.uncertain'));
      dispatch({ type: 'lost' });
    } finally {
      inFlight.current = false;
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (state.phase !== 'editing') return;
    setConfirmTouched(true);
    const problem = validateNewPassword(password, confirm);
    if (problem === 'tooShort') {
      setError(t('auth.password.tooShort', { min: PASSWORD_MIN }));
      return;
    }
    if (problem === 'tooLong') {
      setError(t('account.password.tooLong', { max: PASSWORD_MAX }));
      return;
    }
    if (problem === 'mismatch') {
      setError(t('account.password.mismatch'));
      return;
    }
    dispatch({ type: 'submit', password });
    void send(password);
  }

  function retry() {
    if (state.phase !== 'uncertain') return;
    const { payload } = state;
    dispatch({ type: 'retry' });
    void send(payload);
  }

  function startOver() {
    if (state.phase !== 'uncertain') return;
    setPassword('');
    setConfirm('');
    setConfirmTouched(false);
    setError(null);
    setInfo(t('account.password.startedOver'));
    dispatch({ type: 'startOver' });
  }

  const strength = passwordStrength(password);
  const locked = pending || uncertain;
  const mismatch = confirmTouched && confirm !== password;
  const outcomeText = !settled
    ? ''
    : settled.outcome === 'set'
      ? t('account.password.set')
      : settled.afterRetry
        ? t('account.password.setAfterRetry')
        : t('account.password.alreadySet');

  return (
    <section className="card" aria-labelledby={`${id}-heading`} aria-busy={pending}>
      <h2 id={`${id}-heading`}>{t('account.password.heading')}</h2>
      {/* Persistent live region: present before the swap so the outcome is announced reliably. */}
      <p
        ref={outcomeRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={
          settled?.outcome === 'set'
            ? 'notice notice-success'
            : settled?.outcome === 'alreadySet'
              ? 'notice'
              : 'visually-hidden'
        }
        data-testid="password-outcome"
        data-outcome={settled?.outcome ?? 'none'}
        data-after-retry={settled?.afterRetry ? 'true' : undefined}
      >
        {outcomeText}
      </p>
      {settled ? null : (
        <form method="post" onSubmit={submit} className="form" noValidate>
          <p className="muted">{t('account.password.intro')}</p>
          <div className="field">
            <label htmlFor={`${id}-new`}>{t('account.password.new')}</label>
            <input
              id={`${id}-new`}
              name="new-password"
              type={show ? 'text' : 'password'}
              required
              minLength={PASSWORD_MIN}
              // No maxLength: the browser would truncate typed or pasted text silently; the
              // client check reports "too long" instead so nothing shorter than intended is set.
              autoComplete="new-password"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby={`${id}-hint`}
              value={password}
              readOnly={locked}
              onChange={(e) => setPassword(e.target.value)}
            />
            <small id={`${id}-hint`} className="muted" aria-live="polite">
              {password === ''
                ? t('auth.password.hint', { min: PASSWORD_MIN })
                : t(STRENGTH_KEY[strength], { min: PASSWORD_MIN })}
            </small>
            <label className="inline">
              <input
                type="checkbox"
                checked={show}
                disabled={pending}
                onChange={(e) => setShow(e.target.checked)}
              />{' '}
              {show ? t('account.password.hide') : t('account.password.show')}
            </label>
          </div>
          <div className="field">
            <label htmlFor={`${id}-confirm`}>{t('account.password.confirm')}</label>
            <input
              id={`${id}-confirm`}
              name="confirm-password"
              type={show ? 'text' : 'password'}
              required
              autoComplete="new-password"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={mismatch}
              aria-describedby={`${id}-confirm-hint`}
              value={confirm}
              readOnly={locked}
              onChange={(e) => setConfirm(e.target.value)}
              onBlur={() => setConfirmTouched(true)}
            />
            {/* Always rendered: swapping the text in place keeps the submit button where the pointer
                is, since the blur that reveals a mismatch happens on mousedown over that button. */}
            <small id={`${id}-confirm-hint`} className="muted">
              {mismatch ? t('account.password.mismatch') : t('account.password.confirmHint')}
            </small>
          </div>
          <Notice kind="error">{error}</Notice>
          <Notice>{info}</Notice>
          <div className="actions">
            {uncertain ? (
              <>
                <button type="button" className="primary" onClick={retry}>
                  {t('account.password.retry')}
                </button>
                <button type="button" onClick={startOver}>
                  {t('account.password.startOver')}
                </button>
              </>
            ) : (
              <button type="submit" className="primary" disabled={pending}>
                {pending ? t('common.working') : t('account.password.submit')}
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
