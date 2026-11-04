// SPDX-License-Identifier: Apache-2.0
import type { FeedItemM1b } from '@our-stream/contracts';
import { StyleSheet, Text, View } from 'react-native';
import type { z } from 'zod';
import { Button } from './Button';
import { Player } from './Player';
import { strings } from '../i18n';
import { colors, space, TARGET } from '../lib/theme';

export type FeedItem = z.output<typeof FeedItemM1b>;

export function FeedCard(props: {
  item: FeedItem;
  active: boolean;
  height: number;
  likeBusy: boolean;
  onToggleLike: () => void;
  onOpenComments: () => void;
  onShare: () => void;
  onUnavailable: () => void;
}) {
  const { item } = props;
  const t = strings.feed;
  return (
    <View
      style={[styles.card, { height: props.height }]}
      accessibilityLabel={`${item.title}, ${t.by(item.owner.displayName)}`}
    >
      <Player
        contentId={item.id}
        versionId={item.versionId}
        title={item.title}
        hls={item.media.hls}
        poster={item.media.poster}
        durationMs={item.durationMs}
        active={props.active}
        onUnavailable={props.onUnavailable}
      />
      <View style={styles.meta} pointerEvents="box-none">
        <View style={styles.text}>
          {item.pinned && <Text style={styles.pinned}>{t.pinned}</Text>}
          <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={styles.owner} numberOfLines={1}>
            {t.by(item.owner.displayName)}
            {item.streams[0] ? ` · ${item.streams[0].name}` : ''}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button
            label={item.liked ? t.unlike : t.like}
            accessibilityLabel={`${item.liked ? t.unlike : t.like}. ${t.likes(item.likeCount)}`}
            variant="secondary"
            selected={item.liked}
            busy={props.likeBusy}
            onPress={props.onToggleLike}
            style={[styles.action, item.liked && styles.actionOn]}
          >
            <Text style={[styles.actionText, item.liked && styles.actionTextOn]}>
              {item.liked ? '♥' : '♡'} {item.likeCount}
            </Text>
          </Button>
          <Button
            label={t.openComments}
            accessibilityLabel={`${t.openComments}. ${t.comments(item.commentCount)}`}
            variant="secondary"
            onPress={props.onOpenComments}
            style={styles.action}
          >
            <Text style={styles.actionText}>💬 {item.commentCount}</Text>
          </Button>
          <Button label={t.share} variant="secondary" onPress={props.onShare} style={styles.action}>
            <Text style={styles.actionText}>{t.share}</Text>
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.video, width: '100%' },
  meta: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: space.lg,
    gap: space.md,
    backgroundColor: colors.scrim,
  },
  text: { flex: 1, gap: space.xs },
  pinned: { color: colors.onVideo, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  title: { color: colors.onVideo, fontSize: 18, fontWeight: '700' },
  owner: { color: colors.onVideo, fontSize: 14 },
  actions: { gap: space.sm, alignItems: 'stretch' },
  action: { minWidth: TARGET * 1.6, backgroundColor: 'rgba(255,255,255,0.92)' },
  actionOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  actionText: { fontSize: 15, fontWeight: '600', color: colors.text },
  actionTextOn: { color: colors.onAccent },
});
