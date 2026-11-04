// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useId } from 'react';
import { parseTimestamp } from '@/lib/feed/chapters';
import { t } from '@/lib/i18n';

export interface ChapterDraft {
  key: number;
  at: string;
  title: string;
}

export function ChaptersEditor({
  chapters,
  onChange,
  disabled,
}: {
  chapters: ChapterDraft[];
  onChange: (chapters: ChapterDraft[]) => void;
  disabled?: boolean;
}) {
  const baseId = useId();
  function update(key: number, patch: Partial<ChapterDraft>) {
    onChange(chapters.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }
  return (
    <fieldset className="field">
      <legend>{t('upload.chapters')}</legend>
      <p className="muted" id={`${baseId}-hint`}>
        {t('upload.chaptersHint')}
      </p>
      {chapters.map((c, i) => {
        const invalid = c.at !== '' && parseTimestamp(c.at) === null;
        return (
          <div key={c.key} className="row">
            <label htmlFor={`${baseId}-at-${c.key}`} className="visually-hidden">
              {t('upload.chapterTime', { n: i + 1 })}
            </label>
            <input
              id={`${baseId}-at-${c.key}`}
              className="time"
              placeholder="mm:ss"
              inputMode="numeric"
              value={c.at}
              aria-invalid={invalid}
              aria-describedby={`${baseId}-hint`}
              disabled={disabled}
              onChange={(e) => update(c.key, { at: e.target.value })}
            />
            <label htmlFor={`${baseId}-title-${c.key}`} className="visually-hidden">
              {t('upload.chapterTitle', { n: i + 1 })}
            </label>
            <input
              id={`${baseId}-title-${c.key}`}
              placeholder={t('upload.chapterTitlePlaceholder')}
              maxLength={200}
              value={c.title}
              disabled={disabled}
              onChange={(e) => update(c.key, { title: e.target.value })}
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(chapters.filter((x) => x.key !== c.key))}
              aria-label={t('upload.removeChapter', { n: i + 1 })}
            >
              {t('common.remove')}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        disabled={disabled || chapters.length >= 100}
        onClick={() =>
          onChange([...chapters, { key: Date.now() + chapters.length, at: '', title: '' }])
        }
      >
        {t('upload.addChapter')}
      </button>
    </fieldset>
  );
}
