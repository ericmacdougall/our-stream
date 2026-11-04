-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0003 (M1a worker): two read-only definer functions for the platform role so the worker
-- never trusts outbox payloads for schedule times or org settings (ADR-0003 §transitions, ADR-0005 §2).

-- Authoritative schedule of one content item: the transition job re-reads this at run time and no-ops
-- when the instant it was scheduled for is no longer due (rescheduled or retracted content).
CREATE OR REPLACE FUNCTION platform_content_schedule(p_org uuid, p_content uuid)
RETURNS TABLE (state content_state, publish_at timestamptz, expires_at timestamptz, retracted_at timestamptz, current_version_id uuid, content_epoch bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_content_schedule: org required'; END IF;
  RETURN QUERY SELECT c.state, c.publish_at, c.expires_at, c.retracted_at, c.current_version_id, c.content_epoch
    FROM content c WHERE c.org_id = p_org AND c.id = p_content;
END $$;
REVOKE EXECUTE ON FUNCTION platform_content_schedule(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_content_schedule(uuid, uuid) TO ourstream_platform;

-- Notification settings only (ADR-0005 §2): the title snapshot is attached to retraction notices only
-- when the org opted in; the rest of org.settings stays out of the worker's reach.
CREATE OR REPLACE FUNCTION platform_org_notify_settings(p_org uuid)
RETURNS TABLE (include_title_after_access_loss boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_org_notify_settings: org required'; END IF;
  RETURN QUERY SELECT COALESCE((o.settings -> 'notify' ->> 'include_title_after_access_loss') = 'true', false)
    FROM org o WHERE o.id = p_org;
END $$;
REVOKE EXECUTE ON FUNCTION platform_org_notify_settings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_org_notify_settings(uuid) TO ourstream_platform;

-- Fix (found by the worker integration test): the 0002 body of platform_audience_of_content failed at
-- run time with "column reference user_id is ambiguous" because the OUT column `user_id` shadowed the
-- unqualified `user_id` in the group/stream subqueries. Same semantics, qualified references.
CREATE OR REPLACE FUNCTION platform_audience_of_content(p_org uuid, p_content uuid)
RETURNS TABLE (user_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_audience_of_content: org required'; END IF;
  RETURN QUERY SELECT m.user_id FROM org_membership m
  JOIN content c ON c.org_id = m.org_id AND c.id = p_content
  WHERE m.org_id = p_org AND m.status = 'active'
    AND c.state = 'published' AND c.publish_at IS NOT NULL AND c.publish_at <= now()
    AND (c.expires_at IS NULL OR c.expires_at > now()) AND c.retracted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM content_audience a WHERE a.org_id = c.org_id AND a.content_id = c.id AND (
           a.kind = 'org'
        OR (a.kind = 'user'   AND a.principal_id = m.user_id)
        OR (a.kind = 'group'  AND a.principal_id IN (SELECT g.group_id  FROM user_group_membership g WHERE g.org_id = p_org AND g.user_id = m.user_id))
        OR (a.kind = 'stream' AND a.principal_id IN (SELECT s.stream_id FROM user_stream_access     s WHERE s.org_id = p_org AND s.user_id = m.user_id))));
END $$;
