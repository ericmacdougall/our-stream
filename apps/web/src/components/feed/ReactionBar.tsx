// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Like (toggle button with a constant name and aria-pressed), comments, share, pinned badge and
// event tags for one clip. Counts are plain text, not live regions: they change often and a
// screen reader user already hears the pressed state change.
import { t, type MessageId } from '@/lib/i18n';
import type { M1bItemFields, Tag } from '@/lib/m1b/api';
import { useLike } from '@/lib/m1b/useLike';

export const TAG_LABEL: Record<Tag, MessageId> = {
  onboarding: 'tag.onboarding',
  announcement: 'tag.announcement',
  'current-events': 'tag.current-events',
  training: 'tag.training',
};

export function ReactionBar({
  contentId,
  item,
  commentsOpen,
  onOpenComments,
  onShare,
  onUnavailable,
}: {
  contentId: string;
  item: M1bItemFields;
  commentsOpen: boolean;
  onOpenComments: () => void;
  onShare: () => void;
  onUnavailable: () => void;
}) {
  const like = useLike(contentId, { liked: item.liked, likeCount: item.likeCount }, onUnavailable);
  return (
    <div className="reaction-bar" role="group" aria-label={t('react.label')}>
      <button
        type="button"
        className={like.liked ? 'reaction pressed' : 'reaction'}
        aria-pressed={like.liked}
        onClick={like.toggle}
        data-testid="like-button"
        data-pending={like.pending ? 'true' : undefined}
      >
        {t('react.like')}{' '}
        <span className="count" data-testid="like-count">
          {like.likeCount}
        </span>
      </button>
      <button
        type="button"
        className="reaction"
        aria-expanded={commentsOpen}
        onClick={onOpenComments}
        data-testid="comments-button"
      >
        {t('react.comments')}{' '}
        <span className="count" data-testid="comment-count">
          {item.commentCount}
        </span>
      </button>
      <button type="button" className="reaction" onClick={onShare} data-testid="share-button">
        {t('react.share')}
      </button>
      {item.pinned ? (
        <span className="chip pinned" data-testid="pinned-badge">
          {t('react.pinned')}
        </span>
      ) : null}
      {item.tags.map((tag) => (
        <span key={tag} className="chip tag" data-testid="tag-chip">
          {t(TAG_LABEL[tag])}
        </span>
      ))}
    </div>
  );
}
