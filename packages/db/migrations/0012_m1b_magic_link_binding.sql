-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0012 (M1b mobile PR review F1/F3): a magic link requested by the mobile app is bound to the
-- device that asked for it (PKCE-style). The app sends SHA-256(verifier) when it requests the link and
-- the verifier itself when it consumes it; the database stores only the digest.
--
-- Rollback note (ADR-0012): forward-only. Restoring the 0002 definitions means dropping the two
-- functions below and re-running the 0002 CREATE OR REPLACE statements plus their REVOKE/GRANT; the
-- nullable column is harmless to keep (rows with a challenge simply stop being consumable by the old
-- single-argument function, so drop the column too only after those links have expired).

ALTER TABLE platform.magic_link ADD COLUMN client_challenge bytea;

-- The signatures change (an extra trailing argument with a default), so the old functions are dropped
-- first; otherwise both would exist and a call with the old argument list would be ambiguous.
DROP FUNCTION IF EXISTS platform_magic_link_create(uuid, bytea, text, uuid, interval);
DROP FUNCTION IF EXISTS platform_magic_link_consume(bytea);

CREATE FUNCTION platform_magic_link_create(
  p_user uuid, p_token_hash bytea, p_purpose text, p_org uuid, p_ttl interval, p_client_challenge bytea DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_id uuid;
BEGIN
  IF p_user IS NULL OR p_token_hash IS NULL THEN RAISE EXCEPTION 'platform_magic_link_create: platform-scope, user and token required'; END IF;
  IF p_client_challenge IS NOT NULL AND octet_length(p_client_challenge) <> 32 THEN
    RAISE EXCEPTION 'platform_magic_link_create: platform-scope, client challenge must be a 32-byte digest';
  END IF;
  INSERT INTO platform.magic_link (user_id, token_hash, purpose, org_id, expires_at, client_challenge)
    VALUES (p_user, p_token_hash, p_purpose, p_org, now() + p_ttl, p_client_challenge) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Single use: consumes the link atomically; returns nothing when unknown, expired, already used, or
-- bound to a device and the verifier digest does not match. A refusal never marks the link used, so a
-- spoofed attempt cannot destroy the legitimate link.
CREATE FUNCTION platform_magic_link_consume(p_token_hash bytea, p_verifier_hash bytea DEFAULT NULL)
RETURNS TABLE (user_id uuid, purpose text, org_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'platform_magic_link_consume: platform-scope, token required'; END IF;
  RETURN QUERY UPDATE platform.magic_link l SET used_at = now()
   WHERE l.token_hash = p_token_hash AND l.used_at IS NULL AND l.expires_at > now()
     AND (l.client_challenge IS NULL OR l.client_challenge = p_verifier_hash)
  RETURNING l.user_id, l.purpose, l.org_id;
END $$;

REVOKE EXECUTE ON FUNCTION
  platform_magic_link_create(uuid, bytea, text, uuid, interval, bytea), platform_magic_link_consume(bytea, bytea)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  platform_magic_link_create(uuid, bytea, text, uuid, interval, bytea), platform_magic_link_consume(bytea, bytea)
TO ourstream_app;
