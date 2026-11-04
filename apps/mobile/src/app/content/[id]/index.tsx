// SPDX-License-Identifier: Apache-2.0
// Content detail: player (opens at `?t=` for search hits), like, share, threaded comments.
import type { ContentDetailM1b } from '@our-stream/contracts';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { z } from 'zod';
import { Button } from '../../../components/Button';
import { CommentThread } from '../../../components/CommentThread';
import { Notice } from '../../../components/Notice';
import { Player } from '../../../components/Player';
import { strings } from '../../../i18n';
import {
  applyRemoved,
  editDraft,
  insertReply,
  mergeThreads,
  newDraft,
  validateCommentBody,
  type CommentDraft,
  type CommentThread as Thread,
} from '../../../lib/comments';
import { describeError, errorCodeOf, errorMessage, isUnavailable } from '../../../lib/errors';
import { optimisticToggle } from '../../../lib/feed';
import { newId } from '../../../lib/ids';
import { useSession, useSignedIn } from '../../../lib/session-context';
import { base, colors, space } from '../../../lib/theme';

type Detail = z.output<typeof ContentDetailM1b>;
const t = strings.comments;

/** Direct loads (deep links, web SSR) reach this route before the session exists: gate it. */
export default function ContentScreenRoute() {
  const { state } = useSession();
  if (state.status === 'loading') return null;
  if (state.status === 'signedOut') return <Redirect href="/sign-in" />;
  return <ContentScreen />;
}

function ContentScreen() {
  const { api } = useSignedIn();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; t?: string }>();
  const id = params.id;
  const startMs = params.t ? Math.max(0, Number.parseInt(params.t, 10) || 0) : 0;

  const [detail, setDetail] = useState<Detail | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [likeBusy, setLikeBusy] = useState(false);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  const [canModerate, setCanModerate] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommentDraft>(() => newDraft(newId, null));
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const unavailable = useCallback(() => setGone(true), []);

  const loadComments = useCallback(
    async (after: string | null) => {
      const result = await api.GET('/v1/content/{id}/comments', {
        params: { path: { id }, query: { limit: 50, ...(after ? { cursor: after } : {}) } },
      });
      if (result.error || !result.data) {
        if (isUnavailable(errorCodeOf(result), result.response.status)) setGone(true);
        else setError(errorMessage(result));
        return;
      }
      setThreads((prev) => (after ? mergeThreads(prev, result.data!.items) : result.data!.items));
      setCommentsEnabled(result.data.commentsEnabled);
      setCanModerate(result.data.canModerate);
      setCursor(result.data.nextCursor);
    },
    [api, id],
  );

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const result = await api.GET('/v1/content/{id}', { params: { path: { id } } });
        if (!live) return;
        if (result.error || !result.data) {
          if (isUnavailable(errorCodeOf(result), result.response.status)) setGone(true);
          else setError(errorMessage(result));
          return;
        }
        setDetail(result.data);
        await loadComments(null);
      } catch {
        if (live) setError(strings.errors.offline);
      }
    })();
    return () => {
      live = false;
    };
  }, [api, id, loadComments]);

  const toggleLike = async () => {
    if (!detail || likeBusy) return;
    setLikeBusy(true);
    const before = detail;
    setDetail(optimisticToggle(detail));
    try {
      const p = { params: { path: { id } } };
      const result = before.liked
        ? await api.DELETE('/v1/content/{id}/like', p)
        : await api.POST('/v1/content/{id}/like', p);
      if (result.error || !result.data) {
        if (isUnavailable(errorCodeOf(result), result.response.status)) setGone(true);
        else {
          setDetail(before);
          setNotice(errorMessage(result));
        }
        return;
      }
      setDetail((d) =>
        d ? { ...d, liked: result.data!.liked, likeCount: result.data!.likeCount } : d,
      );
    } catch {
      setDetail(before);
      setNotice(strings.errors.offline);
    } finally {
      setLikeBusy(false);
    }
  };

  const post = async () => {
    const body = validateCommentBody(draft.body);
    if (!body) {
      setNotice(draft.body.trim().length === 0 ? null : t.tooLong);
      return;
    }
    setPosting(true);
    setNotice(null);
    try {
      const result = await api.POST('/v1/content/{id}/comments', {
        params: { path: { id } },
        body: { body, parentId: replyTo, clientKey: draft.clientKey },
      });
      if (result.error || !result.data) {
        const code = errorCodeOf(result);
        if (isUnavailable(code, result.response.status)) setGone(true);
        else if (code === 'comments_disabled') setCommentsEnabled(false);
        else setNotice(describeError(code, result.response.status));
        return; // the draft (and its key) stays for a retry
      }
      setThreads((prev) => insertReply(prev, result.data!));
      setDetail((d) => (d ? { ...d, commentCount: d.commentCount + 1 } : d));
      setDraft(newDraft(newId, null));
      setReplyTo(null);
    } catch {
      setNotice(strings.errors.offline);
    } finally {
      setPosting(false);
    }
  };

  const report = async (commentId: string) => {
    const result = await api.POST('/v1/comments/{id}/report', {
      params: { path: { id: commentId } },
      body: { reason: '' },
    });
    setNotice(result.error ? errorMessage(result) : t.reported);
  };

  const remove = (commentId: string) => {
    const doRemove = async () => {
      const result = await api.POST('/v1/comments/{id}/remove', {
        params: { path: { id: commentId } },
        body: { reason: '' },
      });
      if (result.error || !result.data) {
        setNotice(errorMessage(result));
        return;
      }
      setThreads((prev) => applyRemoved(prev, result.data!));
    };
    if (Platform.OS === 'web') void doRemove();
    else
      Alert.alert(t.confirmRemove, undefined, [
        { text: strings.common.cancel, style: 'cancel' },
        { text: t.remove, style: 'destructive', onPress: () => void doRemove() },
      ]);
  };

  if (gone) {
    return (
      <View style={[base.page, base.pad]}>
        <Notice text={strings.feed.unavailable} />
        <Button label={strings.common.back} variant="secondary" onPress={() => router.back()} />
      </View>
    );
  }

  const replyName = replyTo
    ? (threads.find((th) => th.id === replyTo)?.author?.displayName ?? '')
    : null;

  return (
    <KeyboardAvoidingView
      style={base.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <Notice text={error} kind="error" />
        {detail && (
          <>
            <View style={styles.player}>
              {detail.media && detail.currentVersion ? (
                <Player
                  contentId={detail.id}
                  versionId={detail.currentVersion.id}
                  title={detail.title}
                  hls={detail.media.hls}
                  poster={detail.media.poster}
                  durationMs={detail.currentVersion.durationMs}
                  active
                  startMs={startMs}
                  onUnavailable={unavailable}
                />
              ) : (
                <Text style={[base.body, { color: colors.onVideo, padding: space.lg }]}>
                  {strings.common.loading}
                </Text>
              )}
            </View>
            <View style={base.pad}>
              <Text accessibilityRole="header" style={base.title}>
                {detail.title}
              </Text>
              <Text style={base.muted}>{strings.feed.by(detail.owner.displayName)}</Text>
              {detail.description ? <Text style={base.body}>{detail.description}</Text> : null}
              <View style={base.row}>
                <Button
                  label={detail.liked ? strings.feed.unlike : strings.feed.like}
                  accessibilityLabel={`${detail.liked ? strings.feed.unlike : strings.feed.like}. ${strings.feed.likes(detail.likeCount)}`}
                  variant={detail.liked ? 'primary' : 'secondary'}
                  selected={detail.liked}
                  busy={likeBusy}
                  onPress={() => void toggleLike()}
                >
                  <Text style={[styles.actionText, detail.liked && { color: colors.onAccent }]}>
                    {detail.liked ? '♥' : '♡'} {detail.likeCount}
                  </Text>
                </Button>
                <Button
                  label={strings.feed.share}
                  variant="secondary"
                  onPress={() => router.push({ pathname: '/content/[id]/share', params: { id } })}
                />
              </View>
              <Notice text={notice} />
              <Text accessibilityRole="header" style={base.heading}>
                {t.title} ({detail.commentCount})
              </Text>
              {commentsEnabled ? (
                <View style={base.card}>
                  {replyName !== null && (
                    <View style={base.row}>
                      <Text style={base.muted}>{t.replyPlaceholder(replyName)}</Text>
                      <Button
                        label={t.cancelReply}
                        variant="link"
                        onPress={() => {
                          setReplyTo(null);
                          setDraft((d) => editDraft(d, { parentId: null }, newId));
                        }}
                      />
                    </View>
                  )}
                  <TextInput
                    accessibilityLabel={t.inputLabel}
                    multiline
                    maxLength={2000}
                    placeholder={replyName !== null ? t.replyPlaceholder(replyName) : t.placeholder}
                    placeholderTextColor={colors.muted}
                    style={[base.input, styles.compose]}
                    value={draft.body}
                    onChangeText={(body) => setDraft((d) => editDraft(d, { body }, newId))}
                  />
                  <Button
                    label={t.post}
                    onPress={() => void post()}
                    busy={posting}
                    disabled={draft.body.trim().length === 0}
                  />
                </View>
              ) : (
                <Notice text={t.disabled} />
              )}
              <CommentThread
                threads={threads}
                canModerate={canModerate}
                onReply={(rootId) => {
                  setReplyTo(rootId);
                  setDraft((d) => editDraft(d, { parentId: rootId }, newId));
                }}
                onReport={(cid) => void report(cid)}
                onRemove={remove}
              />
              {cursor && (
                <Button
                  label={strings.feed.loadMore}
                  variant="secondary"
                  onPress={() => void loadComments(cursor)}
                />
              )}
            </View>
          </>
        )}
        {!detail && !error && <Text style={[base.body, base.pad]}>{strings.common.loading}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  player: {
    aspectRatio: 9 / 16,
    maxHeight: 520,
    width: '100%',
    backgroundColor: colors.video,
    alignSelf: 'center',
  },
  compose: { minHeight: 88, paddingTop: space.md, textAlignVertical: 'top' },
  actionText: { fontSize: 15, fontWeight: '600', color: colors.text },
});
