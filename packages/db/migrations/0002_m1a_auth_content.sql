-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0002 (M1a): accounts and sessions through definer functions (the app role has no direct
-- platform privileges, ADR-0001/code-inspection F7), magic links, invites, org bootstrap, content
-- metadata for the feed (links, chapters, captions, processing), notifications, and view recording.

-- ---------------------------------------------------------------------------
-- Platform: magic links and invites (invites are tenant rows; magic links are account rows)
-- ---------------------------------------------------------------------------
CREATE TABLE platform.magic_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES platform.user_account(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  purpose     text NOT NULL CHECK (purpose IN ('login', 'invite', 'verify')),
  org_id      uuid,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX magic_link_user_idx ON platform.magic_link (user_id) WHERE used_at IS NULL;

CREATE TABLE invite (
  org_id        uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL,
  role          org_role NOT NULL DEFAULT 'member',
  invited_by    uuid NOT NULL,
  accepted_at   timestamptz,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '14 days',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, email_normalized)
);
ALTER TABLE invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invite USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON invite TO ourstream_app;

-- ---------------------------------------------------------------------------
-- Content additions
-- ---------------------------------------------------------------------------
ALTER TABLE content
  ADD COLUMN links jsonb NOT NULL DEFAULT '[]'::jsonb,            -- [{kind:'intranet'|'internet'|'attachment', url, label}]
  ADD COLUMN chapters jsonb NOT NULL DEFAULT '[]'::jsonb,         -- [{at_ms, title}] manual in M1a
  ADD COLUMN language text NOT NULL DEFAULT 'en';

ALTER TABLE content_version
  ADD COLUMN original_name text,
  ADD COLUMN original_size bigint,
  ADD COLUMN mime_type text,
  ADD COLUMN duration_ms integer,
  ADD COLUMN width integer,
  ADD COLUMN height integer,
  ADD COLUMN assets jsonb NOT NULL DEFAULT '{}'::jsonb,           -- {hls:{master, renditions:[...]}, poster, sprite, spriteVtt, captions:{lang: key}}
  ADD COLUMN transcript jsonb,                                     -- {language, segments:[{start_ms,end_ms,text}]}
  ADD COLUMN processing_step text,
  ADD COLUMN processing_error text,
  ADD COLUMN processed_at timestamptz;

-- Publication helper: enforces publish_at and state transitions in one place (definer, org-checked).
CREATE OR REPLACE FUNCTION content_publish(p_content uuid, p_publish_at timestamptz, p_expires_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'content_publish: org context required'; END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= COALESCE(p_publish_at, now()) THEN
    RAISE EXCEPTION 'content_publish: expires_at must be after publish_at';
  END IF;
  UPDATE content SET state = 'published', publish_at = COALESCE(p_publish_at, now()), expires_at = p_expires_at, retracted_at = NULL
   WHERE org_id = v_org AND id = p_content AND state IN ('draft', 'published');
  IF NOT FOUND THEN RAISE EXCEPTION 'content_publish: content not found or retracted'; END IF;
END $$;

CREATE OR REPLACE FUNCTION content_retract(p_content uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'content_retract: org context required'; END IF;
  UPDATE content SET state = 'retracted', retracted_at = now() WHERE org_id = v_org AND id = p_content AND state <> 'retracted';
  IF NOT FOUND THEN RAISE EXCEPTION 'content_retract: content not found or already retracted'; END IF;
END $$;

REVOKE EXECUTE ON FUNCTION content_publish(uuid, timestamptz, timestamptz), content_retract(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content_publish(uuid, timestamptz, timestamptz), content_retract(uuid) TO ourstream_app;

-- ---------------------------------------------------------------------------
-- Notifications (in-app channel for M1a; ADR-0005)
-- ---------------------------------------------------------------------------
CREATE TABLE notification (
  org_id         uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  kind           text NOT NULL,                                   -- content.published | content.retracted | content.replaced | invite
  reason         text NOT NULL,                                   -- audience | saw_version | asked_related | invite
  content_id     uuid,
  version_id     uuid,
  title_snapshot text,                                            -- only when the org opts in (ADR-0005)
  dedupe_key     text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  read_at        timestamptz,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, user_id, dedupe_key)
);
CREATE INDEX notification_user_unread_idx ON notification (org_id, user_id, created_at DESC) WHERE read_at IS NULL;
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT, INSERT, UPDATE ON notification TO ourstream_app;

-- Outbox rows are processed by the worker under the platform role, which then writes notifications
-- through this definer function with an explicit org (the worker has no tenant context of its own).
CREATE OR REPLACE FUNCTION platform_notify(p_org uuid, p_user uuid, p_kind text, p_reason text, p_content uuid, p_version uuid, p_title text, p_dedupe text, p_payload jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_notify: org required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_membership m WHERE m.org_id = p_org AND m.user_id = p_user AND m.status = 'active') THEN
    RETURN false;  -- never notify deactivated or non-members (ADR-0005)
  END IF;
  INSERT INTO notification (org_id, user_id, kind, reason, content_id, version_id, title_snapshot, dedupe_key, payload)
    VALUES (p_org, p_user, p_kind, p_reason, p_content, p_version, p_title, p_dedupe, COALESCE(p_payload, '{}'::jsonb))
    ON CONFLICT (org_id, user_id, dedupe_key) DO NOTHING;
  RETURN FOUND;
END $$;
REVOKE EXECUTE ON FUNCTION platform_notify(uuid, uuid, text, text, uuid, uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_notify(uuid, uuid, text, text, uuid, uuid, text, text, jsonb) TO ourstream_platform;

-- Recipients for retraction targeting: active members who viewed a given version (ADR-0005 saw_version).
CREATE OR REPLACE FUNCTION platform_viewers_of_version(p_org uuid, p_version uuid)
RETURNS TABLE (user_id uuid, title_snapshot text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_viewers_of_version: org required'; END IF;
  RETURN QUERY SELECT s.user_id, s.title_snapshot FROM user_content_state s
  JOIN org_membership m ON m.org_id = s.org_id AND m.user_id = s.user_id AND m.status = 'active'
  WHERE s.org_id = p_org AND s.last_version_id = p_version;
END $$;
-- Recipients for publish fan-out: active members for whom the content is reader-visible now.
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
        OR (a.kind = 'group'  AND a.principal_id IN (SELECT group_id  FROM user_group_membership WHERE org_id = p_org AND user_id = m.user_id))
        OR (a.kind = 'stream' AND a.principal_id IN (SELECT stream_id FROM user_stream_access     WHERE org_id = p_org AND user_id = m.user_id))));
END $$;
REVOKE EXECUTE ON FUNCTION platform_viewers_of_version(uuid, uuid), platform_audience_of_content(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_viewers_of_version(uuid, uuid), platform_audience_of_content(uuid, uuid) TO ourstream_platform;

-- The worker reads the minimum content/version/org facts it needs through definer functions as well.
CREATE OR REPLACE FUNCTION platform_content_brief(p_org uuid, p_content uuid)
RETURNS TABLE (title text, state content_state, current_version_id uuid, media_key_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_content_brief: org required'; END IF;
  RETURN QUERY SELECT c.title, c.state, c.current_version_id, c.media_key_id FROM content c WHERE c.org_id = p_org AND c.id = p_content;
END $$;
REVOKE EXECUTE ON FUNCTION platform_content_brief(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_content_brief(uuid, uuid) TO ourstream_platform;

-- Time-driven transition: bump epochs at publish_at / expires_at (ADR-0003/0004); emits the publish event.
CREATE OR REPLACE FUNCTION platform_content_transition(p_org uuid, p_content uuid, p_kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_version uuid;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_content_transition: org required'; END IF;
  UPDATE content SET content_epoch = content_epoch + 1, updated_at = now() WHERE org_id = p_org AND id = p_content RETURNING current_version_id INTO v_version;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM org_epoch_advance(p_org);
  IF p_kind = 'publish' THEN
    INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload)
      VALUES (p_org, 'content.published', 'content', p_content, v_version, '{}'::jsonb);
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION platform_content_transition(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_content_transition(uuid, uuid, text) TO ourstream_platform;

-- Worker writes processing results for a version (status, assets, transcript) without tenant context.
CREATE OR REPLACE FUNCTION platform_version_update(p_org uuid, p_version uuid, p_status version_status, p_step text, p_error text, p_assets jsonb, p_transcript jsonb, p_meta jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_version_update: org required'; END IF;
  UPDATE content_version SET
    status = COALESCE(p_status, status),
    processing_step = COALESCE(p_step, processing_step),
    processing_error = p_error,
    assets = COALESCE(p_assets, assets),
    transcript = COALESCE(p_transcript, transcript),
    duration_ms = COALESCE((p_meta->>'duration_ms')::int, duration_ms),
    width = COALESCE((p_meta->>'width')::int, width),
    height = COALESCE((p_meta->>'height')::int, height),
    processed_at = CASE WHEN p_status = 'current' THEN now() ELSE processed_at END
  WHERE org_id = p_org AND id = p_version;
  IF p_status = 'current' THEN
    UPDATE content_version SET status = 'superseded' WHERE org_id = p_org AND content_id = (SELECT content_id FROM content_version WHERE org_id = p_org AND id = p_version) AND id <> p_version AND status = 'current';
    UPDATE content SET current_version_id = p_version WHERE org_id = p_org AND id = (SELECT content_id FROM content_version WHERE org_id = p_org AND id = p_version);
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION platform_version_update(uuid, uuid, version_status, text, text, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_version_update(uuid, uuid, version_status, text, text, jsonb, jsonb, jsonb) TO ourstream_platform;

CREATE OR REPLACE FUNCTION platform_version_brief(p_org uuid, p_version uuid)
RETURNS TABLE (content_id uuid, status version_status, original_key text, mime_type text, assets jsonb, language text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_version_brief: org required'; END IF;
  RETURN QUERY SELECT v.content_id, v.status, v.original_key, v.mime_type, v.assets, c.language FROM content_version v JOIN content c ON c.org_id = v.org_id AND c.id = v.content_id
  WHERE v.org_id = p_org AND v.id = p_version;
END $$;
REVOKE EXECUTE ON FUNCTION platform_version_brief(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_version_brief(uuid, uuid) TO ourstream_platform;

-- ---------------------------------------------------------------------------
-- Accounts, sessions, magic links: definer functions for the app role
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_account_create(p_email text, p_email_normalized text, p_display_name text, p_password_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_id uuid;
BEGIN
  IF p_email_normalized IS NULL OR p_email_normalized = '' THEN RAISE EXCEPTION 'platform_account_create: platform-scope, email required'; END IF;
  INSERT INTO platform.user_account (email, email_normalized, display_name, password_hash)
    VALUES (p_email, p_email_normalized, p_display_name, p_password_hash) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Returns the password hash only for credential verification inside the API; never exposed to clients.
CREATE OR REPLACE FUNCTION platform_account_by_email(p_email_normalized text)
RETURNS TABLE (id uuid, email text, display_name text, password_hash text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_email_normalized IS NULL THEN RAISE EXCEPTION 'platform_account_by_email: platform-scope, email required'; END IF;
  RETURN QUERY SELECT a.id, a.email, a.display_name, a.password_hash FROM platform.user_account a WHERE a.email_normalized = p_email_normalized;
END $$;

CREATE OR REPLACE FUNCTION platform_account_get(p_id uuid)
RETURNS TABLE (id uuid, email text, display_name text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_id IS NULL THEN RAISE EXCEPTION 'platform_account_get: platform-scope, id required'; END IF;
  RETURN QUERY SELECT a.id, a.email, a.display_name FROM platform.user_account a WHERE a.id = p_id;
END $$;

CREATE OR REPLACE FUNCTION platform_session_create(p_user uuid, p_org uuid, p_token_hash bytea, p_ttl interval)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_id uuid;
BEGIN
  IF p_user IS NULL OR p_token_hash IS NULL THEN RAISE EXCEPTION 'platform_session_create: platform-scope, user and token required'; END IF;
  INSERT INTO platform.session (user_id, org_id, token_hash, expires_at) VALUES (p_user, p_org, p_token_hash, now() + p_ttl) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION platform_session_lookup(p_token_hash bytea)
RETURNS TABLE (session_id uuid, user_id uuid, org_id uuid, expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'platform_session_lookup: platform-scope, token required'; END IF;
  RETURN QUERY SELECT s.id, s.user_id, s.org_id, s.expires_at FROM platform.session s WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now();
END $$;

CREATE OR REPLACE FUNCTION platform_session_revoke(p_token_hash bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'platform_session_revoke: platform-scope, token required'; END IF;
  UPDATE platform.session SET revoked_at = now() WHERE token_hash = p_token_hash AND revoked_at IS NULL;
END $$;

CREATE OR REPLACE FUNCTION platform_session_switch_org(p_token_hash bytea, p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_user uuid;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_session_switch_org: org required'; END IF;
  SELECT user_id INTO v_user FROM platform.session WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now();
  IF v_user IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_membership WHERE org_id = p_org AND user_id = v_user AND status = 'active') THEN RETURN false; END IF;
  UPDATE platform.session SET org_id = p_org WHERE token_hash = p_token_hash;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION platform_magic_link_create(p_user uuid, p_token_hash bytea, p_purpose text, p_org uuid, p_ttl interval)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_id uuid;
BEGIN
  IF p_user IS NULL OR p_token_hash IS NULL THEN RAISE EXCEPTION 'platform_magic_link_create: platform-scope, user and token required'; END IF;
  INSERT INTO platform.magic_link (user_id, token_hash, purpose, org_id, expires_at) VALUES (p_user, p_token_hash, p_purpose, p_org, now() + p_ttl) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Single use: consumes the link atomically; returns nothing when unknown, expired or already used.
CREATE OR REPLACE FUNCTION platform_magic_link_consume(p_token_hash bytea)
RETURNS TABLE (user_id uuid, purpose text, org_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'platform_magic_link_consume: platform-scope, token required'; END IF;
  RETURN QUERY UPDATE platform.magic_link l SET used_at = now()
   WHERE l.token_hash = p_token_hash AND l.used_at IS NULL AND l.expires_at > now()
  RETURNING l.user_id, l.purpose, l.org_id;
END $$;

-- Memberships the account holds (for org switching and the sign-in landing).
CREATE OR REPLACE FUNCTION platform_memberships_of(p_user uuid)
RETURNS TABLE (org_id uuid, slug text, name text, role org_role, status membership_status) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  -- Reads across orgs for one account by design (sign-in landing); no org context applies.
  IF p_user IS NULL THEN RAISE EXCEPTION 'platform_memberships_of: user required (cross-org by design, no org context)'; END IF;
  RETURN QUERY SELECT m.org_id, o.slug, o.name, m.role, m.status FROM org_membership m JOIN org o ON o.id = m.org_id WHERE m.user_id = p_user;
END $$;

-- Org bootstrap: creates the org, the owner membership and the company-wide stream in one step.
CREATE OR REPLACE FUNCTION platform_org_create(p_user uuid, p_slug text, p_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid; v_stream uuid;
BEGIN
  IF p_user IS NULL OR p_slug IS NULL THEN RAISE EXCEPTION 'platform_org_create: user and slug required (creates the org context)'; END IF;
  INSERT INTO org (slug, name) VALUES (p_slug, p_name) RETURNING id INTO v_org;
  PERFORM set_config('app.org_id', v_org::text, true);
  PERFORM set_config('app.user_id', p_user::text, true);
  INSERT INTO org_membership (org_id, user_id, role, status) VALUES (v_org, p_user, 'owner', 'active');
  INSERT INTO stream (org_id, kind, slug, name) VALUES (v_org, 'company', 'company', 'Company-wide') RETURNING id INTO v_stream;
  INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation, created_by)
    VALUES (v_org, 'stream', v_stream, 'viewer', 'org', v_org, 'member', p_user),
           (v_org, 'stream', v_stream, 'owner', 'user', p_user, '', p_user);
  RETURN v_org;
END $$;

-- Invite acceptance: creates the membership for the signed-in account when an invite matches its email.
CREATE OR REPLACE FUNCTION platform_invite_accept(p_user uuid, p_email_normalized text, p_org uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_role org_role;
BEGIN
  IF p_org IS NULL OR p_user IS NULL THEN RAISE EXCEPTION 'platform_invite_accept: org required'; END IF;
  SELECT role INTO v_role FROM invite WHERE org_id = p_org AND email_normalized = p_email_normalized AND accepted_at IS NULL AND expires_at > now();
  IF v_role IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.org_id', p_org::text, true);
  PERFORM set_config('app.user_id', p_user::text, true);
  INSERT INTO org_membership (org_id, user_id, role, status) VALUES (p_org, p_user, v_role, 'active')
    ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'active', role = EXCLUDED.role;
  UPDATE invite SET accepted_at = now() WHERE org_id = p_org AND email_normalized = p_email_normalized;
  RETURN true;
END $$;

REVOKE EXECUTE ON FUNCTION
  platform_account_create(text, text, text, text), platform_account_by_email(text), platform_account_get(uuid),
  platform_session_create(uuid, uuid, bytea, interval), platform_session_lookup(bytea), platform_session_revoke(bytea), platform_session_switch_org(bytea, uuid),
  platform_magic_link_create(uuid, bytea, text, uuid, interval), platform_magic_link_consume(bytea), platform_memberships_of(uuid),
  platform_org_create(uuid, text, text), platform_invite_accept(uuid, text, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  platform_account_create(text, text, text, text), platform_account_by_email(text), platform_account_get(uuid),
  platform_session_create(uuid, uuid, bytea, interval), platform_session_lookup(bytea), platform_session_revoke(bytea), platform_session_switch_org(bytea, uuid),
  platform_magic_link_create(uuid, bytea, text, uuid, interval), platform_magic_link_consume(bytea), platform_memberships_of(uuid),
  platform_org_create(uuid, text, text), platform_invite_accept(uuid, text, uuid)
TO ourstream_app;

-- ---------------------------------------------------------------------------
-- View recording (minimal for M1a: first/last view, version, title snapshot, completion)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_view(p_content uuid, p_version uuid, p_completed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org(); v_user uuid := app_user(); v_title text;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'record_view: org context and user required'; END IF;
  SELECT title INTO v_title FROM content WHERE org_id = v_org AND id = p_content;
  INSERT INTO user_content_state (org_id, user_id, content_id, first_viewed_at, last_viewed_at, last_version_id, title_snapshot, completed_at)
    VALUES (v_org, v_user, p_content, now(), now(), p_version, v_title, CASE WHEN p_completed THEN now() END)
  ON CONFLICT (org_id, user_id, content_id) DO UPDATE SET
    last_viewed_at = now(), last_version_id = EXCLUDED.last_version_id, title_snapshot = EXCLUDED.title_snapshot,
    completed_at = COALESCE(user_content_state.completed_at, EXCLUDED.completed_at);
END $$;
REVOKE EXECUTE ON FUNCTION record_view(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_view(uuid, uuid, boolean) TO ourstream_app;
