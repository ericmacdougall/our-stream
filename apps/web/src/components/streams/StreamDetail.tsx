// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState, type FormEvent } from 'react';
import type { z } from 'zod';
import type { MemberSummary, Stream, StreamMember, StreamRole } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';
import { listItems } from '@/lib/api/lists';
import { errorMessage } from '@/lib/errors';
import { updateStreamComments } from '@/lib/m1b/api';
import { t, type MessageId } from '@/lib/i18n';
import { Notice } from '../Notice';
import { KIND_LABEL } from './StreamsPanel';

type Role = z.output<typeof StreamRole>;
const ROLES: Role[] = ['viewer', 'contributor', 'moderator', 'owner'];
const ROLE_LABEL: Record<Role, MessageId> = {
  viewer: 'streams.role.viewer',
  contributor: 'streams.role.contributor',
  moderator: 'streams.role.moderator',
  owner: 'streams.role.owner',
};

export function StreamDetail({
  stream,
  members: initialMembers,
  orgMembers,
}: {
  stream: z.output<typeof Stream>;
  members: StreamMember[];
  orgMembers: z.output<typeof MemberSummary>[];
}) {
  const [members, setMembers] = useState(initialMembers);
  const [subject, setSubject] = useState<'everyone' | 'user'>('user');
  const [userId, setUserId] = useState(orgMembers[0]?.userId ?? '');
  const [role, setRole] = useState<Role>('viewer');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const canGrant = stream.myRole === 'owner' || stream.myRole === 'moderator';
  // M1b (StreamM1b.commentsEnabled): absent on an M1a server, then treated as allowed.
  const initialComments = (stream as { commentsEnabled?: boolean }).commentsEnabled ?? true;
  const [commentsEnabled, setCommentsEnabled] = useState(initialComments);
  const [commentsPending, setCommentsPending] = useState(false);
  const [commentsStatus, setCommentsStatus] = useState<string | null>(null);

  async function toggleComments(next: boolean) {
    if (commentsPending || next === commentsEnabled) return;
    const previous = commentsEnabled;
    setCommentsPending(true);
    setCommentsEnabled(next);
    setCommentsStatus(null);
    setError(null);
    const result = await updateStreamComments(stream.id, next);
    if (!result.ok) {
      setCommentsEnabled(previous);
      setError(result.message);
    } else {
      setCommentsEnabled(result.data.commentsEnabled);
      setCommentsStatus(t('streams.commentsSaved'));
    }
    setCommentsPending(false);
  }

  async function reloadMembers() {
    const { data } = await browserApi().GET('/v1/streams/{id}/members', {
      params: { path: { id: stream.id } },
    });
    if (data) setMembers(listItems<StreamMember>(data));
  }

  async function grant(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      const body =
        subject === 'everyone'
          ? { role, subject: { type: 'everyone' as const } }
          : { role, subject: { type: 'user' as const, userId } };
      const result = await browserApi().POST('/v1/streams/{id}/grants', {
        params: { path: { id: stream.id } },
        body,
      });
      const message = errorMessage(result);
      if (message) {
        setError(message);
        return;
      }
      setSuccess(t('streams.granted'));
      await reloadMembers();
    } catch {
      setError(t('error.network'));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <header className="masthead">
        <h1>{stream.name}</h1>
        <p className="muted">
          {t(KIND_LABEL[stream.kind])} · {stream.slug}
          {stream.myRole ? ` · ${t('streams.myRole', { role: stream.myRole })}` : ''}
        </p>
      </header>
      {canGrant ? (
        <section
          className="card"
          aria-labelledby="stream-comments-heading"
          data-testid="stream-comments"
        >
          <h2 id="stream-comments-heading">{t('streams.comments')}</h2>
          <label className="inline">
            <input
              type="checkbox"
              checked={commentsEnabled}
              disabled={commentsPending}
              onChange={(e) => void toggleComments(e.target.checked)}
              data-testid="stream-comments-toggle"
            />{' '}
            {commentsEnabled ? t('streams.commentsOn') : t('streams.commentsOff')}
          </label>
          <Notice kind="success">{commentsStatus}</Notice>
        </section>
      ) : null}
      <section aria-labelledby="members-heading" className="card">
        <h2 id="members-heading">{t('streams.membersHeading')}</h2>
        {members.length === 0 ? (
          <p className="muted">{t('streams.membersEmpty')}</p>
        ) : (
          <ul className="list" data-testid="members-list">
            {members.map((m) => (
              <li key={m.userId}>
                {m.displayName} <span className="muted">· {t(ROLE_LABEL[m.role])}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {canGrant ? (
        <form onSubmit={(e) => void grant(e)} className="card form" noValidate>
          <h2>{t('streams.grantHeading')}</h2>
          <fieldset className="field">
            <legend>{t('streams.grantSubject')}</legend>
            <label className="inline">
              <input
                type="radio"
                name="subject"
                value="user"
                checked={subject === 'user'}
                onChange={() => setSubject('user')}
              />{' '}
              {t('streams.grantToUser')}
            </label>
            <label className="inline">
              <input
                type="radio"
                name="subject"
                value="everyone"
                checked={subject === 'everyone'}
                onChange={() => setSubject('everyone')}
              />{' '}
              {t('streams.grantToEveryone')}
            </label>
          </fieldset>
          {subject === 'user' ? (
            <div className="field">
              <label htmlFor="grant-user">{t('streams.grantUser')}</label>
              <select id="grant-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
                {orgMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName} ({m.email})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="grant-role">{t('streams.grantRole')}</label>
            <select id="grant-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(ROLE_LABEL[r])}
                </option>
              ))}
            </select>
          </div>
          <Notice kind="error">{error}</Notice>
          <Notice kind="success">{success}</Notice>
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={pending || (subject === 'user' && !userId)}
            >
              {pending ? t('common.working') : t('streams.grant')}
            </button>
          </div>
        </form>
      ) : null}
    </>
  );
}
