-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0011 (M1b code-inspection fixes, native red-team findings M1, M2, M3, L8).
--
-- Rollback note (ADR-0012): forward-only. The function bodies below replace the 0002/0008/0010
-- versions; restoring them means re-running those CREATE OR REPLACE statements. The data backfills
-- (publish_at truncation, watch_count) are harmless to keep. Also noted here because 0010 is already
-- applied: its rollback list omits platform_digest_items (drop it with the other digest functions),
-- and platform_orgs()'s `current_user IS NULL` guard is a tautology kept only to declare the function's
-- cross-org scope to the schema lint.

-- M3: keyset cursors carry millisecond precision (JS dates), so ordering by date_trunc() in SQL was the
-- fix for the repeated-row bug but defeats content_feed_idx / comment_thread_idx. Store the values
-- already truncated instead, so the raw indexed columns order and compare exactly.
CREATE OR REPLACE FUNCTION content_publish(p_content uuid, p_publish_at timestamptz, p_expires_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'content_publish: org context required'; END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= COALESCE(p_publish_at, now()) THEN
    RAISE EXCEPTION 'content_publish: expires_at must be after publish_at';
  END IF;
  UPDATE content SET state = 'published', publish_at = date_trunc('milliseconds', COALESCE(p_publish_at, now())), expires_at = p_expires_at, retracted_at = NULL
   WHERE org_id = v_org AND id = p_content AND state IN ('draft', 'published');
  IF NOT FOUND THEN RAISE EXCEPTION 'content_publish: content not found or retracted'; END IF;
END $$;
UPDATE content SET publish_at = date_trunc('milliseconds', publish_at)
 WHERE publish_at IS NOT NULL AND publish_at <> date_trunc('milliseconds', publish_at);
ALTER TABLE comment ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());

-- M1: a member whose first contact was the M1a /view route already has first_viewed_at, so the first
-- engagement view_start left watch_count at 0. Count the first watch by watch_count itself.
CREATE OR REPLACE FUNCTION record_engagement(p_content uuid, p_version uuid, p_type text, p_session_key text, p_position_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org(); v_user uuid := app_user(); v_title text; v_state user_content_state%ROWTYPE;
        v_pct smallint; v_sessions integer; v_rewatch boolean := false;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'record_engagement: org context and user required'; END IF;
  IF p_type NOT IN ('view_start', 'progress_25', 'progress_50', 'progress_75', 'complete') THEN
    RAISE EXCEPTION 'record_engagement: unknown type';
  END IF;
  SELECT title INTO v_title FROM content WHERE org_id = v_org AND id = p_content;
  IF v_title IS NULL THEN RAISE EXCEPTION 'record_engagement: content not found'; END IF;
  INSERT INTO user_content_state (org_id, user_id, content_id) VALUES (v_org, v_user, p_content) ON CONFLICT DO NOTHING;
  SELECT * INTO v_state FROM user_content_state WHERE org_id = v_org AND user_id = v_user AND content_id = p_content FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM engagement_event e WHERE e.org_id = v_org AND e.user_id = v_user AND e.content_id = p_content AND e.session_key = p_session_key) THEN
    SELECT count(DISTINCT e.session_key) INTO v_sessions FROM engagement_event e
      WHERE e.org_id = v_org AND e.user_id = v_user AND e.content_id = p_content AND e.at > now() - interval '24 hours';
    IF v_sessions >= 50 THEN RETURN false; END IF;
  END IF;
  INSERT INTO engagement_event (org_id, user_id, content_id, version_id, type, session_key, position_ms)
    VALUES (v_org, v_user, p_content, p_version, p_type, p_session_key, p_position_ms)
    ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  v_pct := CASE p_type WHEN 'progress_25' THEN 25 WHEN 'progress_50' THEN 50 WHEN 'progress_75' THEN 75 WHEN 'complete' THEN 100 ELSE 0 END;
  IF p_type = 'view_start' THEN
    v_rewatch := v_state.completed_at IS NOT NULL OR v_state.max_progress_pct >= 75;
    IF v_rewatch THEN
      INSERT INTO engagement_event (org_id, user_id, content_id, version_id, type, session_key, position_ms)
        VALUES (v_org, v_user, p_content, p_version, 'rewatch', p_session_key, p_position_ms) ON CONFLICT DO NOTHING;
    END IF;
    UPDATE user_content_state SET
      first_viewed_at = COALESCE(first_viewed_at, now()), last_viewed_at = now(), last_version_id = p_version, title_snapshot = v_title,
      watch_count = CASE WHEN watch_count = 0 OR v_rewatch THEN watch_count + 1 ELSE watch_count END,
      last_position_ms = COALESCE(p_position_ms, last_position_ms)
     WHERE org_id = v_org AND user_id = v_user AND content_id = p_content;
  ELSE
    UPDATE user_content_state SET
      first_viewed_at = COALESCE(first_viewed_at, now()), last_viewed_at = now(), last_version_id = p_version, title_snapshot = v_title,
      max_progress_pct = GREATEST(max_progress_pct, v_pct),
      completed_at = CASE WHEN p_type = 'complete' THEN COALESCE(completed_at, now()) ELSE completed_at END,
      last_position_ms = COALESCE(p_position_ms, last_position_ms)
     WHERE org_id = v_org AND user_id = v_user AND content_id = p_content;
  END IF;
  RETURN true;
END $$;
UPDATE user_content_state SET watch_count = 1 WHERE first_viewed_at IS NOT NULL AND watch_count = 0;

-- M2: a digest claimed but never marked (worker crash between claim and mark) stayed `pending` forever
-- with its notifications already stamped. Stale pending claims are retried like failed sends, which makes
-- the documented "a crash after a successful send can repeat one email" the actual failure mode.
-- L8: the two-day window is computed in UTC, matching the worker's UTC day.
CREATE OR REPLACE FUNCTION platform_digest_build(p_org uuid, p_day date)
RETURNS TABLE (user_id uuid, email text, display_name text, notification_ids uuid[], items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_digest_build: org required'; END IF;
  RETURN QUERY
    WITH cand AS (
      SELECT m.user_id AS uid, array_agg(n.id ORDER BY n.created_at) AS ids
        FROM org_membership m
        JOIN notification n ON n.org_id = m.org_id AND n.user_id = m.user_id
        LEFT JOIN member_preference p ON p.org_id = m.org_id AND p.user_id = m.user_id
       WHERE m.org_id = p_org AND m.status = 'active' AND COALESCE(p.email_digest, 'daily') = 'daily'
         AND n.digested_at IS NULL AND n.read_at IS NULL
         AND n.created_at >= ((p_day - 2)::timestamp AT TIME ZONE 'UTC') AND n.created_at < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
         AND NOT EXISTS (SELECT 1 FROM email_digest d WHERE d.org_id = p_org AND d.user_id = m.user_id AND d.digest_date = p_day)
       GROUP BY m.user_id)
    SELECT cand.uid, a.email, a.display_name, cand.ids, platform_digest_items(p_org, cand.uid, cand.ids)
      FROM cand JOIN platform.user_account a ON a.id = cand.uid;
END $$;

CREATE OR REPLACE FUNCTION platform_digest_retry(p_org uuid, p_day date)
RETURNS TABLE (user_id uuid, email text, display_name text, notification_ids uuid[], items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_digest_retry: org required'; END IF;
  RETURN QUERY
    SELECT d.user_id, a.email, a.display_name, d.notification_ids, platform_digest_items(p_org, d.user_id, d.notification_ids)
      FROM email_digest d
      JOIN org_membership m ON m.org_id = d.org_id AND m.user_id = d.user_id AND m.status = 'active'
      JOIN platform.user_account a ON a.id = d.user_id
     WHERE d.org_id = p_org AND d.digest_date = p_day AND d.attempts < 3
       AND (d.status = 'failed' OR (d.status = 'pending' AND d.claimed_at < now() - interval '30 minutes'));
END $$;
