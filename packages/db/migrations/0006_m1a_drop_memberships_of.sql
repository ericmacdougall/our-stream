-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0006 (M1a verification follow-up F7).
-- platform_memberships_of(uuid) has no callers since 0005 replaced it with the session-bound variant;
-- dropping it removes the hazard of a later re-grant to the application role.
DROP FUNCTION IF EXISTS platform_memberships_of(uuid);
