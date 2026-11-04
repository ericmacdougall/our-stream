// SPDX-License-Identifier: Apache-2.0
// Threaded comments rendered as plain text (never markup). Removed comments keep their slot as a
// neutral tombstone; report/remove appear only where the API says the caller may act.
import { StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { strings } from '../i18n';
import type { CommentNode, CommentThread as Thread } from '../lib/comments';
import { base, colors, space } from '../lib/theme';

const t = strings.comments;

function Node(props: {
  comment: CommentNode;
  canModerate: boolean;
  reply?: boolean;
  onReply?: (rootId: string, name: string) => void;
  onReport: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const c = props.comment;
  const removed = c.state === 'removed';
  return (
    <View
      style={[styles.node, props.reply && styles.replyNode]}
      accessibilityLabel={removed ? t.removed : `${c.author?.displayName ?? ''}: ${c.body ?? ''}`}
    >
      {removed ? (
        <Text style={[base.muted, styles.tombstone]}>{t.removed}</Text>
      ) : (
        <>
          <View style={base.row}>
            <Text style={styles.author}>{c.author?.displayName}</Text>
            <Text style={base.muted}>{new Date(c.createdAt).toLocaleString()}</Text>
            {c.reportCount !== undefined && c.reportCount > 0 && (
              <Text style={styles.reports}>{`${c.reportCount} reported`}</Text>
            )}
          </View>
          <Text style={base.body}>{c.body}</Text>
          <View style={base.row}>
            {props.onReply && (
              <Button
                label={t.reply}
                variant="link"
                onPress={() => props.onReply?.(c.parentId ?? c.id, c.author?.displayName ?? '')}
              />
            )}
            {c.canRemove ? (
              <Button label={t.remove} variant="link" onPress={() => props.onRemove(c.id)} />
            ) : (
              <Button label={t.report} variant="link" onPress={() => props.onReport(c.id)} />
            )}
          </View>
        </>
      )}
    </View>
  );
}

export function CommentThread(props: {
  threads: Thread[];
  canModerate: boolean;
  onReply: (rootId: string, name: string) => void;
  onReport: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (props.threads.length === 0) return <Text style={base.body}>{t.empty}</Text>;
  return (
    <View style={{ gap: space.md }}>
      {props.threads.map((root) => (
        <View key={root.id} style={base.card}>
          <Node
            comment={root}
            canModerate={props.canModerate}
            onReply={props.onReply}
            onReport={props.onReport}
            onRemove={props.onRemove}
          />
          {root.replies.map((r) => (
            <Node
              key={r.id}
              comment={r}
              reply
              canModerate={props.canModerate}
              onReply={props.onReply}
              onReport={props.onReport}
              onRemove={props.onRemove}
            />
          ))}
          {root.replyCount > root.replies.length && (
            <Text style={base.muted}>{t.moreReplies(root.replyCount - root.replies.length)}</Text>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  node: { gap: space.xs },
  replyNode: {
    marginLeft: space.lg,
    paddingLeft: space.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    marginTop: space.sm,
  },
  author: { fontWeight: '700', color: colors.text, fontSize: 15 },
  reports: { color: colors.danger, fontSize: 13 },
  tombstone: { fontStyle: 'italic' },
});
