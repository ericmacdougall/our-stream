-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0004 (M1a review fixes, red-team F3/F4 and the publish-while-processing gap).

-- F3: an invited address gets a password-less account; signup must be able to adopt it instead of
-- failing with "email taken". Only succeeds when no password is set yet.
CREATE OR REPLACE FUNCTION platform_account_set_password_if_unset(p_id uuid, p_password_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_id IS NULL OR p_password_hash IS NULL THEN RAISE EXCEPTION 'platform_account_set_password_if_unset: platform-scope, id and hash required'; END IF;
  UPDATE platform.user_account SET password_hash = p_password_hash, updated_at = now()
   WHERE id = p_id AND password_hash IS NULL;
  RETURN FOUND;
END $$;
REVOKE EXECUTE ON FUNCTION platform_account_set_password_if_unset(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_account_set_password_if_unset(uuid, text) TO ourstream_app;

-- F4: outbox attempt counting so poison events cannot starve the drain.
ALTER TABLE platform.domain_event
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error text;
DROP INDEX IF EXISTS platform.domain_event_unprocessed_idx;
CREATE INDEX domain_event_unprocessed_idx ON platform.domain_event (attempts, id) WHERE processed_at IS NULL;

-- Publish-while-processing: when a version becomes current and its content is already published and
-- live, announce it exactly once (the publish-time event found no media to announce).
CREATE OR REPLACE FUNCTION platform_version_update(p_org uuid, p_version uuid, p_status version_status, p_step text, p_error text, p_assets jsonb, p_transcript jsonb, p_meta jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_content uuid; v_state content_state; v_publish_at timestamptz; v_expires_at timestamptz; v_retracted timestamptz;
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
  WHERE org_id = p_org AND id = p_version
  RETURNING content_id INTO v_content;
  IF v_content IS NULL THEN RETURN; END IF;
  IF p_status = 'current' THEN
    UPDATE content_version SET status = 'superseded' WHERE org_id = p_org AND content_id = v_content AND id <> p_version AND status = 'current';
    UPDATE content SET current_version_id = p_version WHERE org_id = p_org AND id = v_content
      RETURNING state, publish_at, expires_at, retracted_at INTO v_state, v_publish_at, v_expires_at, v_retracted;
    IF v_state = 'published' AND v_retracted IS NULL AND v_publish_at IS NOT NULL AND v_publish_at <= now()
       AND (v_expires_at IS NULL OR v_expires_at > now())
       AND NOT EXISTS (SELECT 1 FROM platform.domain_event e WHERE e.org_id = p_org AND e.type = 'content.published' AND e.subject_id = v_content AND e.version_id = p_version) THEN
      INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload)
        VALUES (p_org, 'content.published', 'content', v_content, p_version, '{"source":"processing_complete"}'::jsonb);
    END IF;
  END IF;
END $$;
