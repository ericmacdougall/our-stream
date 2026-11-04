-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0008 (M1b): engagement events and per-user progress (ADR-0006), with the org privacy mode
-- and comment settings kept in org.settings (read and merged by the API; defaults apply when absent:
-- privacy.viewers = identified_for_required_only (decision Q1), comments.enabled = true,
-- engagement.retention_days = 395 (decision Q12), scan.comments = off (ADR-0009)).
--
-- Rollback note (ADR-0012): drop engagement_event and the functions record_engagement,
-- platform_engagement_prune, platform_org_retention; the user_content_state columns added here may stay
-- (defaults keep M1a code valid) or be dropped.
--
-- engagement_event is a plain table for M1b (decision recorded in docs/decisions.md): monthly
-- partitioning arrives with the M8 retention work once volume justifies it; the prune job bounds growth.

CREATE TABLE engagement_event (
  org_id      uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  id          bigint GENERATED ALWAYS AS IDENTITY,
  user_id     uuid NOT NULL,
  content_id  uuid NOT NULL,
  version_id  uuid NOT NULL,
  type        text NOT NULL CHECK (type IN ('view_start', 'progress_25', 'progress_50', 'progress_75', 'complete', 'rewatch')),
  session_key text NOT NULL CHECK (length(session_key) BETWEEN 1 AND 64),
  position_ms integer CHECK (position_ms IS NULL OR position_ms >= 0),
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  -- The idempotency key (ADR-0006: milestones are idempotent per user, version and milestone; here per playback session).
  UNIQUE (org_id, user_id, content_id, version_id, type, session_key),
  FOREIGN KEY (org_id, content_id) REFERENCES content(org_id, id) ON DELETE CASCADE
);
CREATE INDEX engagement_event_content_idx ON engagement_event (org_id, content_id, type);
CREATE INDEX engagement_event_at_idx ON engagement_event (org_id, at);
ALTER TABLE engagement_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON engagement_event USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT ON engagement_event TO ourstream_app;   -- writes only through record_engagement

ALTER TABLE user_content_state
  ADD COLUMN max_progress_pct smallint NOT NULL DEFAULT 0 CHECK (max_progress_pct BETWEEN 0 AND 100),
  ADD COLUMN watch_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_position_ms integer;

-- Records one engagement event idempotently and keeps user_content_state current. A view_start also
-- performs the record_view upsert (last_version_id, title_snapshot) so retraction targeting
-- (platform_viewers_of_version, ADR-0005) works for clients that only send engagement (review F1).
-- Rewatch = a view_start from a new session after the user completed or passed 75 % (review F11).
-- At most 50 distinct session keys per (user, item, 24 h); beyond that the event is dropped (false).
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
  -- The state row is the per-(user, item) serialisation point.
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
      watch_count = CASE WHEN first_viewed_at IS NULL OR v_rewatch THEN watch_count + 1 ELSE watch_count END,
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

-- Retention (decision Q12, default 13 months): the worker prunes raw events in bounded batches.
CREATE OR REPLACE FUNCTION platform_org_retention(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_org_retention: org required'; END IF;
  RETURN (SELECT LEAST(3650, GREATEST(30, COALESCE((o.settings -> 'engagement' ->> 'retention_days')::int, 395))) FROM org o WHERE o.id = p_org);
END $$;

CREATE OR REPLACE FUNCTION platform_engagement_prune(p_org uuid, p_before timestamptz, p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_n integer;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_engagement_prune: org required'; END IF;
  WITH victims AS (
    SELECT org_id, id FROM engagement_event WHERE org_id = p_org AND at < p_before ORDER BY at LIMIT LEAST(GREATEST(p_limit, 1), 10000)
  )
  DELETE FROM engagement_event e USING victims v WHERE e.org_id = v.org_id AND e.id = v.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE EXECUTE ON FUNCTION record_engagement(uuid, uuid, text, text, integer), platform_org_retention(uuid), platform_engagement_prune(uuid, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_engagement(uuid, uuid, text, text, integer) TO ourstream_app;
GRANT EXECUTE ON FUNCTION platform_org_retention(uuid), platform_engagement_prune(uuid, timestamptz, integer) TO ourstream_platform;
