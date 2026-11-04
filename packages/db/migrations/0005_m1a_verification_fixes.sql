-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0005 (M1a verification repairs).

-- Memberships breadth: platform_memberships_of(uuid) let the application role list any account's
-- organisations by id. The replacement binds the read to a live session token, so the API can only
-- list memberships for the account that presented a valid, unexpired, unrevoked session.
CREATE OR REPLACE FUNCTION platform_memberships_of_session(p_token_hash bytea)
RETURNS TABLE (org_id uuid, slug text, name text, role org_role, status membership_status)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  -- Reads across orgs for one account by design (sign-in landing); the session is the org-less scope.
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'platform_memberships_of_session: token required (cross-org by design: reads the presented session''s memberships, no org context)'; END IF;
  RETURN QUERY
    SELECT m.org_id, o.slug, o.name, m.role, m.status
      FROM platform.session s
      JOIN org_membership m ON m.user_id = s.user_id
      JOIN org o ON o.id = m.org_id
     WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now();
END $$;
REVOKE EXECUTE ON FUNCTION platform_memberships_of_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_memberships_of_session(bytea) TO ourstream_app;
REVOKE EXECUTE ON FUNCTION platform_memberships_of(uuid) FROM ourstream_app;
