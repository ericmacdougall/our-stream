-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0007 (M1b): reactions and threaded, moderated comments (decision Q7), plus the account
-- password-state read used by the account settings page.
--
-- Rollback note (ADR-0012, forward-only expand step): no M1a object is altered. To back out, drop
-- comment_report, comment, reaction, the comment_state type and the functions comment_remove,
-- comment_report, comment_can_moderate, platform_comment_brief and platform_account_has_password.
--
-- Ownership of rows is enforced in the single tenant policy's WITH CHECK (permissive policies OR
-- together, so a second INSERT-only policy would not restrict anything): the application role can only
-- insert a reaction, comment or report as the user in its tenant context; every later update of those
-- rows goes through a definer function below.

CREATE TABLE reaction (
  org_id     uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  content_id uuid NOT NULL,
  user_id    uuid NOT NULL,
  kind       text NOT NULL DEFAULT 'like' CHECK (kind IN ('like')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, content_id, user_id, kind),
  FOREIGN KEY (org_id, content_id) REFERENCES content(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id) REFERENCES org_membership(org_id, user_id) ON DELETE CASCADE
);
ALTER TABLE reaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE reaction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reaction USING (org_id = app_org()) WITH CHECK (org_id = app_org() AND user_id = app_user());
GRANT SELECT, INSERT, DELETE ON reaction TO ourstream_app;

CREATE TYPE comment_state AS ENUM ('visible', 'removed');

-- One nesting level: a reply carries root_id (the root comment it belongs to); replies to replies attach
-- to the same root. Tombstones keep the thread shape; the body and author are withheld by the API.
CREATE TABLE comment (
  org_id         uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  content_id     uuid NOT NULL,
  root_id        uuid,
  author_id      uuid NOT NULL,
  body           text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  body_hash      bytea NOT NULL,                      -- sha256(body): idempotency replay comparison
  client_key     text CHECK (client_key IS NULL OR length(client_key) BETWEEN 1 AND 64),
  state          comment_state NOT NULL DEFAULT 'visible',
  report_count   integer NOT NULL DEFAULT 0,
  removed_at     timestamptz,
  removed_by     uuid,
  removal_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, content_id) REFERENCES content(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, root_id) REFERENCES comment(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, author_id) REFERENCES org_membership(org_id, user_id),
  CONSTRAINT comment_removed_shape CHECK (state <> 'removed' OR removed_at IS NOT NULL)
);
-- Idempotency key per (author, item): a replay elsewhere writes a new comment (review F2).
CREATE UNIQUE INDEX comment_client_key_idx ON comment (org_id, author_id, content_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX comment_thread_idx ON comment (org_id, content_id, root_id, created_at, id);
ALTER TABLE comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON comment USING (org_id = app_org()) WITH CHECK (org_id = app_org() AND author_id = app_user());
GRANT SELECT, INSERT ON comment TO ourstream_app;

CREATE TABLE comment_report (
  org_id      uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  comment_id  uuid NOT NULL,
  reporter_id uuid NOT NULL,
  reason      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, comment_id, reporter_id),
  FOREIGN KEY (org_id, comment_id) REFERENCES comment(org_id, id) ON DELETE CASCADE
);
ALTER TABLE comment_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_report FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON comment_report USING (org_id = app_org()) WITH CHECK (org_id = app_org() AND reporter_id = app_user());
GRANT SELECT ON comment_report TO ourstream_app;

-- The moderation rule in one place (Q7): org owners/admins, or moderators/owners of a stream the item
-- is addressed to. The content owner has no moderation right by virtue of ownership.
CREATE OR REPLACE FUNCTION comment_can_moderate(p_org uuid, p_user uuid, p_content uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM org_membership m WHERE m.org_id = p_org AND m.user_id = p_user AND m.status = 'active' AND m.role IN ('owner', 'admin'))
      OR EXISTS (SELECT 1 FROM content_audience a
                 JOIN user_stream_access usa ON usa.org_id = a.org_id AND usa.stream_id = a.principal_id AND usa.user_id = p_user
                 WHERE a.org_id = p_org AND a.content_id = p_content AND a.kind = 'stream' AND usa.role IN ('moderator', 'owner'))
$$;

-- Removal by the author (own comment) or a moderator; every removal is an audit event. Returns NULL
-- when the comment does not exist in this org, true otherwise (already removed is idempotent).
CREATE OR REPLACE FUNCTION comment_remove(p_comment uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org(); v_user uuid := app_user(); v_content uuid; v_author uuid; v_state comment_state; v_role text;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'comment_remove: org context and user required'; END IF;
  SELECT content_id, author_id, state INTO v_content, v_author, v_state FROM comment WHERE org_id = v_org AND id = p_comment FOR UPDATE;
  IF v_content IS NULL THEN RETURN NULL; END IF;
  IF v_author = v_user THEN v_role := 'author';
  ELSIF comment_can_moderate(v_org, v_user, v_content) THEN v_role := 'moderator';
  ELSE RAISE EXCEPTION 'comment_remove: forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_state = 'removed' THEN RETURN true; END IF;
  UPDATE comment SET state = 'removed', removed_at = now(), removed_by = v_user, removal_reason = left(COALESCE(p_reason, ''), 500)
   WHERE org_id = v_org AND id = p_comment;
  INSERT INTO audit_event (org_id, actor_id, action, target)
    VALUES (v_org, v_user, 'comment.removed', jsonb_build_object('commentId', p_comment, 'contentId', v_content, 'reason', left(COALESCE(p_reason, ''), 500), 'actorRole', v_role));
  RETURN true;
END $$;

-- One report per reporter per comment; the counter moves only when a new report lands.
CREATE OR REPLACE FUNCTION comment_report(p_comment uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org(); v_user uuid := app_user();
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'comment_report: org context and user required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM comment WHERE org_id = v_org AND id = p_comment) THEN RETURN NULL; END IF;
  INSERT INTO comment_report (org_id, comment_id, reporter_id, reason) VALUES (v_org, p_comment, v_user, left(COALESCE(p_reason, ''), 500))
    ON CONFLICT (org_id, comment_id, reporter_id) DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE comment SET report_count = report_count + 1 WHERE org_id = v_org AND id = p_comment;
  RETURN true;
END $$;

-- Worker read for comment notifications (ADR-0005 reasons `commented`, `replied`).
CREATE OR REPLACE FUNCTION platform_comment_brief(p_org uuid, p_comment uuid)
RETURNS TABLE (content_id uuid, author_id uuid, content_owner_id uuid, root_author_id uuid, state comment_state)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_comment_brief: org required'; END IF;
  RETURN QUERY SELECT k.content_id, k.author_id, c.owner_id, r.author_id, k.state
    FROM comment k JOIN content c ON c.org_id = k.org_id AND c.id = k.content_id
    LEFT JOIN comment r ON r.org_id = k.org_id AND r.id = k.root_id
    WHERE k.org_id = p_org AND k.id = p_comment;
END $$;

-- Account settings: whether a password exists, never the hash (web owner request; cheap pre-check for
-- POST /v1/auth/password so a 409 does not cost an argon2 hash).
CREATE OR REPLACE FUNCTION platform_account_has_password(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_id IS NULL THEN RAISE EXCEPTION 'platform_account_has_password: platform-scope, id required'; END IF;
  RETURN EXISTS (SELECT 1 FROM platform.user_account a WHERE a.id = p_id AND a.password_hash IS NOT NULL);
END $$;

REVOKE EXECUTE ON FUNCTION comment_can_moderate(uuid, uuid, uuid), comment_remove(uuid, text), comment_report(uuid, text),
  platform_comment_brief(uuid, uuid), platform_account_has_password(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION comment_can_moderate(uuid, uuid, uuid), comment_remove(uuid, text), comment_report(uuid, text),
  platform_account_has_password(uuid) TO ourstream_app;
GRANT EXECUTE ON FUNCTION platform_comment_brief(uuid, uuid) TO ourstream_platform;
