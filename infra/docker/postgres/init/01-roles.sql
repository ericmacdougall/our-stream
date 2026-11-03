-- SPDX-License-Identifier: AGPL-3.0-only
-- Development bootstrap: application role without BYPASSRLS and without table ownership (ADR-0001).
-- Production installs create these roles with their own secret management.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ourstream_app') THEN
    CREATE ROLE ourstream_app LOGIN PASSWORD 'ourstream-app-dev-only' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ourstream_platform') THEN
    CREATE ROLE ourstream_platform LOGIN PASSWORD 'ourstream-platform-dev-only' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT CONNECT ON DATABASE ourstream TO ourstream_app, ourstream_platform;
