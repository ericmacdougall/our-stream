// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Share as a link (ADR-0002: sharing never widens access). Picks a colleague, sends the in-app
// notification, and offers the internal link for copying. `delivered: false` is shown without a
// reason; the link only works for people who can already see the clip.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { browserApi } from '@/lib/api/client';
import { listItems } from '@/lib/api/lists';
import { useSession } from '@/components/SessionProvider';
import { t } from '@/lib/i18n';
import { shareUrl, shareWith } from '@/lib/m1b/api';
import { isUnavailableCode } from '@/lib/m1b/comments';
import { Notice } from '../Notice';

interface Member {
  userId: string;
  displayName: string;
}

export function ShareDialog({
  contentId,
  title,
  onClose,
  onUnavailable,
}: {
  contentId: string | null;
  title: string;
  onClose: () => void;
  onUnavailable: (contentId: string) => void;
}) {
  const me = useSession();
  const ref = useRef<HTMLDialogElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [recipient, setRecipient] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ delivered: boolean; name: string; url: string } | null>(
    null,
  );
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const inFlight = useRef(false);
  const open = contentId !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) {
      setOutcome(null);
      setError(null);
      setCopied(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await browserApi().GET('/v1/members');
        if (cancelled || !data) return;
        const list = listItems<{ userId: string; displayName: string; status: string }>(data)
          .filter(
            (m: { userId: string; displayName: string; status: string }) =>
              m.status === 'active' && m.userId !== me?.user.id,
          )
          .map((m: { userId: string; displayName: string }) => ({
            userId: m.userId,
            displayName: m.displayName,
          }));
        setMembers(list);
        setRecipient((r) => r || (list[0]?.userId ?? ''));
      } catch {
        if (!cancelled) setError(t('error.network'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, me?.user.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!contentId || inFlight.current || !recipient) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await shareWith(contentId, recipient);
      if (!result.ok) {
        if (isUnavailableCode(result.code)) onUnavailable(contentId);
        setError(result.message);
        return;
      }
      const url = shareUrl(window.location.origin, result.data.linkPath);
      if (!url) {
        setError(t('error.generic'));
        return;
      }
      const name = members.find((m) => m.userId === recipient)?.displayName ?? '';
      setOutcome({ delivered: result.data.delivered, name, url });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function copy() {
    if (!outcome) return;
    try {
      await navigator.clipboard.writeText(outcome.url);
      setCopied('yes');
    } catch {
      setCopied('no');
      linkRef.current?.select();
    }
  }

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="share-heading"
      onClose={onClose}
      data-testid="share-dialog"
    >
      <h2 id="share-heading">{t('share.title')}</h2>
      <p className="muted">{t('share.intro', { title })}</p>
      {outcome ? (
        <div className="form">
          <p role="status" data-testid="share-outcome" data-delivered={String(outcome.delivered)}>
            {outcome.delivered ? t('share.sent', { name: outcome.name }) : t('share.notDelivered')}
          </p>
          <div className="field">
            <label htmlFor="share-link">{t('share.link')}</label>
            <input
              id="share-link"
              ref={linkRef}
              readOnly
              value={outcome.url}
              data-testid="share-link"
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <Notice kind={copied === 'no' ? 'error' : 'success'}>
            {copied === 'yes' ? t('share.copied') : copied === 'no' ? t('share.copyFailed') : null}
          </Notice>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void copy()}>
              {t('share.copy')}
            </button>
            <button type="button" onClick={onClose}>
              {t('share.close')}
            </button>
          </div>
        </div>
      ) : (
        <form
          method="post"
          onSubmit={(e) => void submit(e)}
          className="form"
          noValidate
          aria-busy={pending}
        >
          <div className="field">
            <label htmlFor="share-recipient">{t('share.recipient')}</label>
            <select
              id="share-recipient"
              value={recipient}
              disabled={pending || members.length === 0}
              onChange={(e) => setRecipient(e.target.value)}
            >
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </select>
            {members.length === 0 ? <small className="muted">{t('share.nobody')}</small> : null}
          </div>
          <Notice kind="error">{error}</Notice>
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={pending || !recipient}
              data-testid="share-send"
            >
              {pending ? t('common.working') : t('share.send')}
            </button>
            <button type="button" onClick={onClose} disabled={pending}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
