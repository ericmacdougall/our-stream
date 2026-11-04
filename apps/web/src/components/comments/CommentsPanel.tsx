// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Threaded comments for one clip (Q7: open, moderated by stream moderators, reportable, no
// anonymous posts, org/stream can disable). Drafts keep one clientKey per text (comments.ts) and
// persist in sessionStorage so a reload cannot post twice; a lost response is retried identically
// and then frozen behind a Retry button. The panel carries data-shortcuts-off so feed single-key
// and arrow shortcuts stay off while the viewer types or reads here.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '@/components/SessionProvider';
import { t } from '@/lib/i18n';
import {
  COMMENT_PAGE,
  createComment,
  listComments,
  mintClientKey,
  removeComment,
  reportComment,
  type CommentThread,
} from '@/lib/m1b/api';
import {
  applyRemoved,
  draftStorageKey,
  isUnavailableCode,
  mergeComment,
  newDraft,
  reduceDraft,
  restoreDraft,
  serialiseDraft,
  type CommentNode,
  type Draft,
  type DraftEvent,
} from '@/lib/m1b/comments';
import { Notice } from '../Notice';

type Status = 'loading' | 'ready' | 'unavailable' | 'error';

function readStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode): the draft simply does not survive a reload.
  }
}

function CommentForm({
  contentId,
  parentId,
  focusOnMount,
  onPosted,
  onCancel,
  onDisabled,
  onUnavailable,
  onRefetch,
}: {
  contentId: string;
  parentId: string | null;
  focusOnMount?: boolean;
  onPosted: (comment: CommentThread) => void;
  onCancel?: () => void;
  onDisabled: () => void;
  onUnavailable: () => void;
  onRefetch: () => void;
}) {
  const me = useSession();
  const storageKey = draftStorageKey(me?.user.id ?? 'anonymous', contentId, parentId);
  const [draft, setDraft] = useState<Draft>(() => newDraft(parentId, mintClientKey));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const inFlight = useRef(false);
  const id = `comment-form-${parentId ?? 'root'}`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Focus follows the explicit Reply click (not a page-load autofocus).
  useEffect(() => {
    if (focusOnMount) textareaRef.current?.focus();
  }, [focusOnMount]);

  // Restore the persisted draft (with its key) after mount; persist on every change.
  useEffect(() => {
    const restored = restoreDraft(readStored(storageKey), parentId, mintClientKey);
    draftRef.current = restored;
    setDraft(restored);
  }, [storageKey, parentId]);
  useEffect(() => {
    writeStored(storageKey, draft.body === '' ? null : serialiseDraft(draft));
  }, [draft, storageKey]);

  function apply(event: DraftEvent) {
    const out = reduceDraft(draftRef.current, event);
    draftRef.current = out.draft;
    setDraft(out.draft);
    if (out.send) void send(out.send);
  }

  async function send(payload: { body: string; parentId: string | null; clientKey: string }) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setInfo(null);
    try {
      const result = await createComment(contentId, payload);
      if (result.ok) {
        inFlight.current = false;
        onPosted(result.data);
        apply({ type: 'sent' });
        return;
      }
      if (isUnavailableCode(result.code)) onUnavailable();
      if (result.code === 'comments_disabled') onDisabled();
      if (result.code === 'idempotency_mismatch') {
        setInfo(t('comments.postedEarlier'));
        onRefetch();
      } else if (!result.lost) {
        setError(result.message);
      }
      const definite = !result.lost;
      const failed: DraftEvent = definite
        ? result.code
          ? { type: 'failed', definite, code: result.code }
          : { type: 'failed', definite }
        : { type: 'failed', definite };
      // Release the guard before apply(): an automatic retry starts inside it and must own it.
      inFlight.current = false;
      apply(failed);
      if (draftRef.current.phase === 'uncertain') setError(t('comments.uncertain'));
    } catch {
      inFlight.current = false;
      setError(t('error.network'));
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    apply({ type: 'send' });
  }

  const sending = draft.phase === 'sending';
  const uncertain = draft.phase === 'uncertain';
  return (
    <form method="post" onSubmit={submit} className="comment-form" aria-busy={sending} noValidate>
      <label htmlFor={id} className="visually-hidden">
        {parentId ? t('comments.replyPlaceholder') : t('comments.placeholder')}
      </label>
      <textarea
        id={id}
        rows={2}
        maxLength={2000}
        placeholder={parentId ? t('comments.replyPlaceholder') : t('comments.placeholder')}
        value={draft.body}
        readOnly={sending || uncertain}
        ref={textareaRef}
        onChange={(e) => apply({ type: 'edit', body: e.target.value })}
      />
      <Notice kind="error">{error}</Notice>
      <Notice>{info}</Notice>
      <div className="actions">
        {uncertain ? (
          <>
            <button type="button" className="primary" onClick={() => apply({ type: 'retry' })}>
              {t('comments.retry')}
            </button>
            <button
              type="button"
              onClick={() => {
                const fresh = newDraft(parentId, mintClientKey);
                draftRef.current = fresh;
                setDraft(fresh);
                setError(null);
              }}
            >
              {t('comments.discard')}
            </button>
          </>
        ) : (
          <button
            type="submit"
            className="primary"
            disabled={sending || draft.body.trim() === ''}
            data-testid={parentId ? 'post-reply' : 'post-comment'}
          >
            {sending
              ? t('comments.sending')
              : parentId
                ? t('comments.postReply')
                : t('comments.post')}
          </button>
        )}
        {onCancel ? (
          <button type="button" onClick={onCancel} disabled={sending}>
            {t('comments.cancelReply')}
          </button>
        ) : null}
      </div>
    </form>
  );
}

function CommentView({
  node,
  canModerate,
  reported,
  onReply,
  onReport,
  onRemove,
}: {
  node: CommentNode;
  canModerate: boolean;
  reported: boolean;
  onReply?: () => void;
  onReport: () => void;
  onRemove: () => void;
}) {
  const removed = node.state === 'removed';
  const name = node.author?.displayName ?? '';
  return (
    <div
      id={`comment-${node.id}`}
      className={removed ? 'comment removed' : 'comment'}
      tabIndex={-1}
      data-testid="comment"
      data-comment-id={node.id}
      data-state={node.state}
    >
      {removed ? (
        <p className="muted">{t('comments.removed')}</p>
      ) : (
        <>
          <p className="comment-head">
            <strong>{name}</strong>{' '}
            <time dateTime={node.createdAt} className="muted">
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(node.createdAt))}
            </time>
            {canModerate && node.reportCount ? (
              <span className="chip">{t('comments.reportCount', { count: node.reportCount })}</span>
            ) : null}
          </p>
          <p className="comment-body">{node.body}</p>
          <div className="comment-actions">
            {onReply ? (
              <button
                type="button"
                onClick={onReply}
                aria-label={t('comments.replyLabel', { name })}
              >
                {t('comments.reply')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onReport}
              disabled={reported}
              aria-label={t('comments.reportLabel', { name })}
              data-testid="report-button"
            >
              {reported ? t('comments.reported') : t('comments.report')}
            </button>
            {node.canRemove ? (
              <button
                type="button"
                onClick={onRemove}
                aria-label={t('comments.removeLabel', { name })}
                data-testid="remove-button"
              >
                {t('comments.remove')}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export function CommentsPanel({
  contentId,
  title,
  onClose,
  onUnavailable,
  onCountDelta,
}: {
  contentId: string;
  title: string;
  onClose?: () => void;
  onUnavailable: () => void;
  onCountDelta?: (delta: number) => void;
}) {
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<CommentThread[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [canModerate, setCanModerate] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reported, setReported] = useState<Set<string>>(new Set());
  const [removeTarget, setRemoveTarget] = useState<CommentNode | null>(null);
  const [removing, setRemoving] = useState(false);
  // Focus target after a removal; applied from an effect declared after the dialog-close effect so
  // dialog.close() (which restores focus to the vanished Remove button) runs first and loses.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reportInFlight = useRef(false);
  const headingId = `comments-heading-${contentId}`;

  const load = useCallback(
    async (cursor?: string) => {
      const result = await listComments(contentId, cursor);
      if (!result.ok) {
        if (isUnavailableCode(result.code)) {
          setStatus('unavailable');
          onUnavailable();
        } else {
          setStatus('error');
          setError(result.message);
        }
        return;
      }
      setItems((prev) => {
        let next = cursor ? prev : [];
        for (const item of result.data.items) next = mergeComment(next, item);
        return next;
      });
      setNextCursor(result.data.nextCursor);
      setEnabled(result.data.commentsEnabled);
      setCanModerate(result.data.canModerate);
      setStatus('ready');
    },
    [contentId, onUnavailable],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (removeTarget && !dialog.open) dialog.showModal();
    if (!removeTarget && dialog.open) dialog.close();
  }, [removeTarget]);

  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`comment-${focusId}`);
    el?.focus();
    setFocusId(null);
  }, [focusId]);

  function posted(comment: CommentThread) {
    setItems((prev) => mergeComment(prev, comment));
    onCountDelta?.(1);
    setReplyTo(null);
    setAnnounce(t('comments.posted'));
  }

  async function report(node: CommentNode) {
    if (reportInFlight.current || reported.has(node.id)) return;
    reportInFlight.current = true;
    try {
      const result = await reportComment(node.id);
      if (result.ok) {
        setReported((prev) => new Set(prev).add(node.id));
        setAnnounce(t('comments.reportedStatus'));
      } else if (isUnavailableCode(result.code) && result.code !== 'comment_not_found') {
        onUnavailable();
      } else {
        setError(result.message);
      }
    } finally {
      reportInFlight.current = false;
    }
  }

  async function confirmRemove() {
    const target = removeTarget;
    if (!target || removing) return;
    setRemoving(true);
    setError(null);
    try {
      const result = await removeComment(target.id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setItems((prev) => applyRemoved(prev, result.data));
      onCountDelta?.(-1);
      setRemoveTarget(null);
      setAnnounce(t('comments.removed'));
      // Focus the tombstone so the keyboard user stays where the comment was.
      setFocusId(target.id);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <section
      className="comments-drawer"
      aria-labelledby={headingId}
      data-shortcuts-off="true"
      data-testid="comments-panel"
    >
      <div className="comments-head">
        <h2 id={headingId}>{t('comments.title', { title })}</h2>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label={t('comments.close')}>
            {t('common.close')}
          </button>
        ) : null}
      </div>
      <div className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </div>
      {status === 'loading' ? <p className="muted">{t('common.loading')}</p> : null}
      {status === 'unavailable' ? <Notice kind="error">{t('comments.unavailable')}</Notice> : null}
      <Notice kind="error">{error}</Notice>
      {status === 'ready' ? (
        <>
          {enabled ? (
            <CommentForm
              contentId={contentId}
              parentId={null}
              onPosted={posted}
              onDisabled={() => setEnabled(false)}
              onUnavailable={() => {
                setStatus('unavailable');
                onUnavailable();
              }}
              onRefetch={() => void load()}
            />
          ) : (
            <div data-testid="comments-disabled">
              <Notice>{t('comments.disabled')}</Notice>
            </div>
          )}
          {items.length === 0 ? <p className="muted">{t('comments.empty')}</p> : null}
          <ol className="comment-list">
            {items.map((root) => (
              <li key={root.id}>
                <CommentView
                  node={root}
                  canModerate={canModerate}
                  reported={reported.has(root.id)}
                  {...(enabled && root.state === 'visible'
                    ? { onReply: () => setReplyTo(replyTo === root.id ? null : root.id) }
                    : {})}
                  onReport={() => void report(root)}
                  onRemove={() => setRemoveTarget(root)}
                />
                {root.replies.length > 0 ? (
                  <ol className="comment-replies">
                    {root.replies.map((reply) => (
                      <li key={reply.id}>
                        <CommentView
                          node={reply}
                          canModerate={canModerate}
                          reported={reported.has(reply.id)}
                          onReport={() => void report(reply)}
                          onRemove={() => setRemoveTarget(reply)}
                        />
                      </li>
                    ))}
                  </ol>
                ) : null}
                {root.replies.length < root.replyCount ? (
                  <p className="muted">
                    {t('comments.moreReplies', { count: root.replyCount - root.replies.length })}
                  </p>
                ) : null}
                {replyTo === root.id && enabled ? (
                  <CommentForm
                    contentId={contentId}
                    parentId={root.id}
                    focusOnMount
                    onPosted={posted}
                    onCancel={() => setReplyTo(null)}
                    onDisabled={() => setEnabled(false)}
                    onUnavailable={() => {
                      setStatus('unavailable');
                      onUnavailable();
                    }}
                    onRefetch={() => void load()}
                  />
                ) : null}
              </li>
            ))}
          </ol>
          {nextCursor ? (
            <button type="button" onClick={() => void load(nextCursor)}>
              {t('comments.loadMore')}
            </button>
          ) : null}
          <p className="muted comments-page-note">{t('comments.pageNote', { n: COMMENT_PAGE })}</p>
        </>
      ) : null}
      <dialog
        ref={dialogRef}
        className="dialog"
        aria-labelledby={`${headingId}-remove`}
        onCancel={(e) => {
          // Escape keeps the comment.
          e.preventDefault();
          if (!removing) setRemoveTarget(null);
        }}
        onClose={() => {
          if (!removing) setRemoveTarget(null);
        }}
      >
        <h2 id={`${headingId}-remove`}>{t('comments.removeTitle')}</h2>
        <p>{t('comments.removeBody')}</p>
        <div className="actions">
          <button type="button" onClick={() => setRemoveTarget(null)} disabled={removing}>
            {t('comments.keep')}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void confirmRemove()}
            disabled={removing}
            data-testid="remove-confirm"
          >
            {removing ? t('common.working') : t('comments.removeConfirm')}
          </button>
        </div>
      </dialog>
    </section>
  );
}
