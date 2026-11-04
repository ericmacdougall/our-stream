-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0010 (M1b): pins, the closed event-tag enum on content.event_tags, per-member notification
-- preferences and the daily email digest bookkeeping (ADR-0005 §5).
--
-- Rollback note (ADR-0012): drop email_digest, member_preference, content_pin, the content CHECK
-- constraint content_event_tags_valid, the notification.digested_at column and its index, and the
-- functions event_tags_valid, platform_orgs, platform_digest_build, platform_digest_claim,
-- platform_digest_mark, platform_digest_retry.

-- Tags are a closed enum (risk R11: no free-text identity to normalise). Checked by the database too.
CREATE OR REPLACE FUNCTION event_tags_valid(p_tags text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_tags IS NOT NULL
     AND p_tags <@ ARRAY['onboarding', 'announcement', 'current-events', 'training']::text[]
     AND cardinality(p_tags) <= 4
     AND NOT EXISTS (SELECT 1 FROM unnest(p_tags) t GROUP BY t HAVING count(*) > 1)
$$;
ALTER TABLE content ADD CONSTRAINT content_event_tags_valid CHECK (event_tags_valid(event_tags));
CREATE INDEX content_event_tags_idx ON content USING gin (event_tags);

-- Pins: org-wide (scope_id = org id) or per stream. A stream pin counts only while the item is still
-- addressed to that stream (joined at read time, review F19).
CREATE TABLE content_pin (
  org_id     uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  content_id uuid NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('org', 'stream')),
  scope_id   uuid NOT NULL,
  pinned_by  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope_kind, scope_id, content_id),
  FOREIGN KEY (org_id, content_id) REFERENCES content(org_id, id) ON DELETE CASCADE,
  CONSTRAINT content_pin_scope CHECK (scope_kind <> 'org' OR scope_id = org_id)
);
ALTER TABLE content_pin ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_pin FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_pin USING (org_id = app_org()) WITH CHECK (org_id = app_org() AND pinned_by = app_user());
GRANT SELECT, INSERT, DELETE ON content_pin TO ourstream_app;

CREATE TABLE member_preference (
  org_id       uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  email_digest text NOT NULL DEFAULT 'daily' CHECK (email_digest IN ('daily', 'off')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES org_membership(org_id, user_id) ON DELETE CASCADE
);
ALTER TABLE member_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_preference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON member_preference USING (org_id = app_org()) WITH CHECK (org_id = app_org() AND user_id = app_user());
GRANT SELECT, INSERT, UPDATE ON member_preference TO ourstream_app;

-- Digest bookkeeping. Everything that exists before this migration counts as digested, so the first
-- run never emails the M1a backlog (review F4).
ALTER TABLE notification ADD COLUMN digested_at timestamptz;
UPDATE notification SET digested_at = now();
CREATE INDEX notification_undigested_idx ON notification (org_id, user_id) WHERE digested_at IS NULL;

CREATE TABLE email_digest (
  org_id           uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  digest_date      date NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  item_count       integer NOT NULL DEFAULT 0,
  notification_ids uuid[] NOT NULL DEFAULT '{}',
  claimed_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  last_error       text,
  PRIMARY KEY (org_id, user_id, digest_date)
);
ALTER TABLE email_digest ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_digest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_digest USING (org_id = app_org()) WITH CHECK (org_id = app_org());
-- no grants: the platform role reaches it through the definer functions below only

-- Scheduled platform jobs iterate orgs by id; nothing else about an org is exposed here.
CREATE OR REPLACE FUNCTION platform_orgs() RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF current_user IS NULL THEN RAISE EXCEPTION 'platform_orgs: cross-org by design (org ids for scheduled jobs; no org context)'; END IF;
  RETURN QUERY SELECT o.id FROM org o ORDER BY o.created_at;
END $$;

-- Candidate digests for one org and day: active members with the daily preference and undigested,
-- unread notifications of the last two days, excluding members already claimed for that day. Titles are
-- resolved here with the readerVisible predicate (ADR-0005 §6): a title the member can no longer see is
-- null and the digest shows a neutral line.
CREATE OR REPLACE FUNCTION platform_digest_items(p_org uuid, p_user uuid, p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_digest_items: org required'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', n.id, 'kind', n.kind, 'reason', n.reason, 'contentId', n.content_id, 'createdAt', n.created_at,
             'title', CASE WHEN c.id IS NOT NULL
                AND EXISTS (SELECT 1 FROM org_membership m WHERE m.org_id = p_org AND m.user_id = p_user AND m.status = 'active')
                AND c.state = 'published' AND c.publish_at IS NOT NULL AND c.publish_at <= now()
                AND (c.expires_at IS NULL OR c.expires_at > now()) AND c.retracted_at IS NULL
                AND EXISTS (SELECT 1 FROM content_audience a WHERE a.org_id = c.org_id AND a.content_id = c.id AND (
                       a.kind = 'org'
                    OR (a.kind = 'user' AND a.principal_id = p_user)
                    OR (a.kind = 'group' AND a.principal_id IN (SELECT g.group_id FROM user_group_membership g WHERE g.org_id = p_org AND g.user_id = p_user))
                    OR (a.kind = 'stream' AND a.principal_id IN (SELECT s.stream_id FROM user_stream_access s WHERE s.org_id = p_org AND s.user_id = p_user))))
               THEN c.title ELSE NULL END
           ) ORDER BY n.created_at)
    FROM notification n LEFT JOIN content c ON c.org_id = n.org_id AND c.id = n.content_id
    WHERE n.org_id = p_org AND n.user_id = p_user AND n.id = ANY(p_ids)
  ), '[]'::jsonb);
END $$;

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
         AND n.created_at >= (p_day - 2)::timestamptz AND n.created_at < (p_day + 1)::timestamptz
         AND NOT EXISTS (SELECT 1 FROM email_digest d WHERE d.org_id = p_org AND d.user_id = m.user_id AND d.digest_date = p_day)
       GROUP BY m.user_id)
    SELECT cand.uid, a.email, a.display_name, cand.ids, platform_digest_items(p_org, cand.uid, cand.ids)
      FROM cand JOIN platform.user_account a ON a.id = cand.uid;
END $$;

-- The claim is the at-most-once-per-day guarantee: the row insert and the digested_at marks happen in
-- one call; a second claim for the same (user, day) returns false and marks nothing.
CREATE OR REPLACE FUNCTION platform_digest_claim(p_org uuid, p_user uuid, p_day date, p_ids uuid[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_digest_claim: org required'; END IF;
  INSERT INTO email_digest (org_id, user_id, digest_date, item_count, notification_ids)
    VALUES (p_org, p_user, p_day, cardinality(p_ids), p_ids) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE notification SET digested_at = now() WHERE org_id = p_org AND user_id = p_user AND id = ANY(p_ids) AND digested_at IS NULL;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION platform_digest_mark(p_org uuid, p_user uuid, p_day date, p_sent boolean, p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_digest_mark: org required'; END IF;
  UPDATE email_digest SET status = CASE WHEN p_sent THEN 'sent' ELSE 'failed' END, attempts = attempts + 1,
         sent_at = CASE WHEN p_sent THEN now() ELSE sent_at END, last_error = CASE WHEN p_sent THEN NULL ELSE left(p_error, 500) END
   WHERE org_id = p_org AND user_id = p_user AND digest_date = p_day;
END $$;

-- Claimed digests whose send failed are retried on later runs of the same day, at most three attempts.
-- Items are re-resolved so a title lost since the claim is no longer included.
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
     WHERE d.org_id = p_org AND d.digest_date = p_day AND d.status = 'failed' AND d.attempts < 3;
END $$;

REVOKE EXECUTE ON FUNCTION platform_orgs(), platform_digest_items(uuid, uuid, uuid[]), platform_digest_build(uuid, date),
  platform_digest_claim(uuid, uuid, date, uuid[]), platform_digest_mark(uuid, uuid, date, boolean, text), platform_digest_retry(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_orgs(), platform_digest_build(uuid, date), platform_digest_claim(uuid, uuid, date, uuid[]),
  platform_digest_mark(uuid, uuid, date, boolean, text), platform_digest_retry(uuid, date) TO ourstream_platform;
