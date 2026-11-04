// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Audience + schedule. Submission is guarded by a synchronous ref so a double-click sends one
// request; controls are disabled while pending. publishAt/expiresAt are entered in the viewer's
// zone (datetime-local) and sent as ISO-8601 UTC.
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import type { AudienceTarget, ContentDetail, MemberSummary, Stream } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { isoToLocalDateTime, localDateTimeToIso } from '@/lib/schedule';
import { useSession } from '@/components/SessionProvider';
import { pin, setTags, withM1bDefaults, type Tag } from '@/lib/m1b/api';
import { TAGS } from '@/lib/m1b/search';
import { TAG_LABEL } from '@/lib/m1b/tags';
import { Notice } from '../Notice';

type Target = z.output<typeof AudienceTarget>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildAudience(input: {
  everyone: boolean;
  streamIds: Iterable<string>;
  userIds: Iterable<string>;
  groupIds: Iterable<string>;
}): Target[] {
  const out: Target[] = [];
  if (input.everyone) out.push({ type: 'everyone' });
  for (const streamId of input.streamIds) out.push({ type: 'stream', streamId });
  for (const groupId of input.groupIds) out.push({ type: 'group', groupId });
  for (const userId of input.userIds) out.push({ type: 'user', userId });
  return out;
}

export function PublishForm({
  content,
  streams,
  members,
}: {
  content: z.output<typeof ContentDetail>;
  streams: z.output<typeof Stream>[];
  members: z.output<typeof MemberSummary>[];
}) {
  const router = useRouter();
  const me = useSession();
  const canPinOrgWide = ['owner', 'admin', 'announcer'].includes(me?.org?.role ?? '');
  const [tags, setTagsState] = useState<Tag[]>(withM1bDefaults(content).tags);
  const [pinOrgWide, setPinOrgWide] = useState(false);
  const existing = content.audience;
  const [everyone, setEveryone] = useState(existing.some((a) => a.type === 'everyone'));
  const [streamIds, setStreamIds] = useState<Set<string>>(
    new Set(existing.flatMap((a) => (a.type === 'stream' ? [a.streamId] : []))),
  );
  const [userIds, setUserIds] = useState<Set<string>>(
    new Set(existing.flatMap((a) => (a.type === 'user' ? [a.userId] : []))),
  );
  const [groupText, setGroupText] = useState(
    existing.flatMap((a) => (a.type === 'group' ? [a.groupId] : [])).join('\n'),
  );
  const [mode, setMode] = useState<'now' | 'schedule'>(content.publishAt ? 'schedule' : 'now');
  const [publishAtLocal, setPublishAtLocal] = useState(
    content.publishAt ? isoToLocalDateTime(content.publishAt) : '',
  );
  const [expiresLocal, setExpiresLocal] = useState(
    content.expiresAt ? isoToLocalDateTime(content.expiresAt) : '',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  function toggle(set: Set<string>, id: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setError(null);
    const groupIds = groupText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const badGroup = groupIds.find((g) => !UUID_RE.test(g));
    if (badGroup) {
      setError(t('publish.groupInvalid', { value: badGroup }));
      return;
    }
    const audience = buildAudience({ everyone, streamIds, userIds, groupIds });
    if (audience.length === 0) {
      setError(t('publish.audienceRequired'));
      return;
    }
    let publishAt: string | null = null;
    if (mode === 'schedule') {
      publishAt = localDateTimeToIso(publishAtLocal);
      if (!publishAt) {
        setError(t('publish.scheduleInvalid'));
        return;
      }
    }
    let expiresAt: string | null = null;
    if (expiresLocal.trim() !== '') {
      expiresAt = localDateTimeToIso(expiresLocal);
      if (!expiresAt) {
        setError(t('publish.expiryInvalid'));
        return;
      }
      if (new Date(expiresAt).getTime() <= new Date(publishAt ?? Date.now()).getTime()) {
        setError(t('publish.expiryBeforePublish'));
        return;
      }
    }
    inFlight.current = true;
    setPending(true);
    try {
      const result = await browserApi().POST('/v1/content/{id}/publish', {
        params: { path: { id: content.id } },
        body: { audience, publishAt, expiresAt },
      });
      const message = errorMessage(result);
      if (message) {
        setError(message);
        return;
      }
      // M1b: tags and an org-wide pin are applied after the publish succeeded (a pin needs a
      // published clip); a failure here leaves the clip published and reports the step.
      const initialTags = withM1bDefaults(content).tags;
      const tagsChanged =
        tags.length !== initialTags.length || tags.some((x) => !initialTags.includes(x));
      if (tagsChanged) {
        const tagged = await setTags(content.id, tags);
        if (!tagged.ok) {
          setError(tagged.message);
          return;
        }
      }
      // A pin needs a published clip, so it is only offered when publishing now.
      if (pinOrgWide && canPinOrgWide && publishAt === null) {
        const pinned = await pin(content.id, null);
        if (!pinned.ok) {
          setError(pinned.code === 'not_published' ? t('pins.notPublished') : pinned.message);
          return;
        }
      }
      router.push(publishAt ? `/content/${content.id}` : '/');
      router.refresh();
    } catch {
      setError(t('error.network'));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const ready = content.currentVersion?.status === 'current';

  return (
    <form
      method="post"
      onSubmit={(e) => void submit(e)}
      className="card form"
      noValidate
      aria-busy={pending}
    >
      <h2>{t('publish.heading', { title: content.title })}</h2>
      {!ready ? <Notice kind="error">{t('publish.notReady')}</Notice> : null}
      <fieldset className="field" disabled={pending}>
        <legend>{t('publish.audience')}</legend>
        <label className="inline">
          <input
            type="checkbox"
            name="everyone"
            checked={everyone}
            onChange={(e) => setEveryone(e.target.checked)}
          />{' '}
          {t('publish.everyone')}
        </label>
        <p className="muted">{t('publish.streams')}</p>
        {streams.length === 0 ? <p className="muted">{t('streams.empty')}</p> : null}
        {streams.map((s) => (
          <label key={s.id} className="inline">
            <input
              type="checkbox"
              name="stream"
              value={s.id}
              checked={streamIds.has(s.id)}
              onChange={() => toggle(streamIds, s.id, setStreamIds)}
            />{' '}
            {s.name}
          </label>
        ))}
        <p className="muted">{t('publish.people')}</p>
        {members.map((m) => (
          <label key={m.userId} className="inline">
            <input
              type="checkbox"
              name="user"
              value={m.userId}
              checked={userIds.has(m.userId)}
              onChange={() => toggle(userIds, m.userId, setUserIds)}
            />{' '}
            {m.displayName}
          </label>
        ))}
        <div className="field">
          <label htmlFor="groups">{t('publish.groups')}</label>
          <textarea
            id="groups"
            rows={2}
            value={groupText}
            aria-describedby="groups-hint"
            onChange={(e) => setGroupText(e.target.value)}
          />
          <small id="groups-hint" className="muted">
            {t('publish.groupsHint')}
          </small>
        </div>
      </fieldset>
      <fieldset className="field" disabled={pending}>
        <legend>{t('publish.tags')}</legend>
        <p className="muted">{t('tags.hint')}</p>
        {TAGS.map((tag) => (
          <label key={tag} className="inline">
            <input
              type="checkbox"
              name="tags"
              value={tag}
              checked={tags.includes(tag)}
              onChange={(e) =>
                setTagsState((prev) =>
                  e.target.checked
                    ? [...prev.filter((x) => x !== tag), tag]
                    : prev.filter((x) => x !== tag),
                )
              }
            />{' '}
            {t(TAG_LABEL[tag])}
          </label>
        ))}
        {canPinOrgWide && mode === 'now' ? (
          <label className="inline">
            <input
              type="checkbox"
              name="pinOrgWide"
              checked={pinOrgWide}
              onChange={(e) => setPinOrgWide(e.target.checked)}
            />{' '}
            {t('publish.pinOrgWide')}
          </label>
        ) : null}
      </fieldset>
      <fieldset className="field" disabled={pending}>
        <legend>{t('publish.when')}</legend>
        <label className="inline">
          <input
            type="radio"
            name="mode"
            value="now"
            checked={mode === 'now'}
            onChange={() => setMode('now')}
          />{' '}
          {t('publish.now')}
        </label>
        <label className="inline">
          <input
            type="radio"
            name="mode"
            value="schedule"
            checked={mode === 'schedule'}
            onChange={() => setMode('schedule')}
          />{' '}
          {t('publish.schedule')}
        </label>
        {mode === 'schedule' ? (
          <div className="field">
            <label htmlFor="publishAt">{t('publish.publishAt')}</label>
            <input
              id="publishAt"
              type="datetime-local"
              required
              value={publishAtLocal}
              aria-describedby="publishAt-hint"
              onChange={(e) => setPublishAtLocal(e.target.value)}
            />
            <small id="publishAt-hint" className="muted">
              {t('publish.zoneHint', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
            </small>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="expiresAt">{t('publish.expiresAt')}</label>
          <input
            id="expiresAt"
            type="datetime-local"
            value={expiresLocal}
            onChange={(e) => setExpiresLocal(e.target.value)}
          />
        </div>
      </fieldset>
      <Notice kind="error">{error}</Notice>
      <div className="actions">
        <button type="submit" className="primary" disabled={pending || !ready}>
          {pending
            ? t('common.working')
            : mode === 'now'
              ? t('publish.submitNow')
              : t('publish.submitSchedule')}
        </button>
      </div>
    </form>
  );
}
