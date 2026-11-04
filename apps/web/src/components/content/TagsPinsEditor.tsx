// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Event tags (up to four) and pins per explicit target. The contract exposes one `pinned`
// aggregate per clip, so each target offers both Pin and Unpin and the server stays the judge;
// only targets the server would accept are listed (lib/m1b/pins.ts).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import type { ContentDetail } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';
import { listItems } from '@/lib/api/lists';
import { useSession } from '@/components/SessionProvider';
import { t } from '@/lib/i18n';
import { pin, setTags, unpin, withM1bDefaults, type Detail, type Tag } from '@/lib/m1b/api';
import { pinTargets, type OrgRole, type PinTarget, type StreamRole } from '@/lib/m1b/pins';
import { TAGS } from '@/lib/m1b/search';
import { TAG_LABEL } from '@/lib/m1b/tags';
import { Notice } from '../Notice';

type M1aDetail = z.output<typeof ContentDetail>;

export function TagsPinsEditor({
  detail,
  onDetail,
}: {
  detail: M1aDetail;
  onDetail: (detail: Detail) => void;
}) {
  const me = useSession();
  const fields = withM1bDefaults(detail);
  const [tags, setTagsState] = useState<Tag[]>(fields.tags);
  const [streams, setStreams] = useState<{ id: string; name: string; myRole: StreamRole | null }[]>(
    [],
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const inFlight = useRef(false);

  // The server copy is the truth after each save; local edits start from it.
  const tagKey = fields.tags.join(',');
  useEffect(() => {
    setTagsState(tagKey === '' ? [] : (tagKey.split(',') as Tag[]));
  }, [tagKey]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await browserApi().GET('/v1/streams');
        if (!cancelled) setStreams(listItems(data));
      } catch {
        // Without the list, stream pins are simply not offered.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const targets: PinTarget[] = pinTargets({
    orgRole: (me?.org?.role as OrgRole | undefined) ?? null,
    audience: detail.audience,
    streams,
  }).map((target) => ({ ...target, label: target.label || t('pins.orgWide') }));

  async function saveTags(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending('tags');
    setError(null);
    setStatus(null);
    try {
      const result = await setTags(detail.id, tags);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDetail(result.data);
      setStatus(t('tags.saved'));
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  async function togglePin(target: PinTarget, on: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(`${on ? 'pin' : 'unpin'}:${target.streamId ?? 'org'}`);
    setError(null);
    setStatus(null);
    try {
      const result = on
        ? await pin(detail.id, target.streamId)
        : await unpin(detail.id, target.streamId);
      if (!result.ok) {
        setError(result.code === 'not_published' ? t('pins.notPublished') : result.message);
        return;
      }
      onDetail(result.data);
      setStatus(on ? t('pins.pinned') : t('pins.unpinned'));
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  function toggleTag(tag: Tag, checked: boolean) {
    setTagsState((prev) => {
      const next = prev.filter((x) => x !== tag);
      return checked ? [...next, tag] : next;
    });
  }

  return (
    <section className="card" aria-labelledby="tags-heading" data-testid="tags-pins">
      <form method="post" onSubmit={(e) => void saveTags(e)} className="form" noValidate>
        <h2 id="tags-heading">{t('tags.heading')}</h2>
        <fieldset className="field" disabled={pending !== null}>
          <legend className="visually-hidden">{t('tags.heading')}</legend>
          <p className="muted">{t('tags.hint')}</p>
          {TAGS.map((tag) => (
            <label key={tag} className="inline">
              <input
                type="checkbox"
                name="tag"
                value={tag}
                checked={tags.includes(tag)}
                onChange={(e) => toggleTag(tag, e.target.checked)}
              />{' '}
              {t(TAG_LABEL[tag])}
            </label>
          ))}
        </fieldset>
        <div className="actions">
          <button
            type="submit"
            className="primary"
            disabled={pending !== null}
            data-testid="save-tags"
          >
            {pending === 'tags' ? t('common.working') : t('tags.save')}
          </button>
        </div>
      </form>
      <h3 id="pins-heading">{t('pins.heading')}</h3>
      <p className="muted">{t('pins.hint')}</p>
      {fields.pinned ? (
        <p>
          <span className="chip pinned" data-testid="pinned-badge">
            {t('react.pinned')}
          </span>
        </p>
      ) : null}
      {targets.length === 0 ? (
        <p className="muted" data-testid="no-pin-targets">
          {t('pins.noTargets')}
        </p>
      ) : (
        <ul className="list" aria-labelledby="pins-heading">
          {targets.map((target) => {
            const key = target.streamId ?? 'org';
            return (
              <li key={key} className="row" data-testid="pin-target" data-stream={key}>
                <span>{target.label}</span>
                <button
                  type="button"
                  disabled={pending !== null}
                  aria-label={t('pins.pinLabel', { target: target.label })}
                  onClick={() => void togglePin(target, true)}
                  data-testid="pin"
                >
                  {pending === `pin:${key}` ? t('common.working') : t('pins.pin')}
                </button>
                <button
                  type="button"
                  disabled={pending !== null}
                  aria-label={t('pins.unpinLabel', { target: target.label })}
                  onClick={() => void togglePin(target, false)}
                  data-testid="unpin"
                >
                  {pending === `unpin:${key}` ? t('common.working') : t('pins.unpin')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Notice kind="error">{error}</Notice>
      <Notice kind="success">{status}</Notice>
    </section>
  );
}
