#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Development bootstrap (ADR-0001): application roles without BYPASSRLS and without table ownership.
# Passwords come from the container environment so overrides in compose actually take effect.
set -euo pipefail
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
: "${PLATFORM_DB_PASSWORD:?PLATFORM_DB_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$APP_DB_PASSWORD" -v platform_pw="$PLATFORM_DB_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ourstream_app') THEN
    CREATE ROLE ourstream_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ourstream_platform') THEN
    CREATE ROLE ourstream_platform LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE ourstream_app PASSWORD :'app_pw';
ALTER ROLE ourstream_platform PASSWORD :'platform_pw';
GRANT CONNECT ON DATABASE ourstream TO ourstream_app, ourstream_platform;
SQL
