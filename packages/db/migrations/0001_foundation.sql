-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0001: foundation schema (ADR-0001 tenancy, ADR-0002 permissions, ADR-0003 versions,
-- ADR-0004 epochs, ADR-0005 outbox). Hand-written SQL; security objects are reviewed as code.
-- Runs as the migration (owner) role. Application roles: ourstream_app (tenant), ourstream_platform (queue/outbox).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS platform;

-- ---------------------------------------------------------------------------
-- Tenant context helpers (fail closed when unset: NULL never equals an org id)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Platform (non-tenant) tables
-- ---------------------------------------------------------------------------
CREATE TABLE platform.user_account (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  email_normalized text NOT NULL UNIQUE,            -- NFKC + casefold (risk R11)
  display_name     text NOT NULL,
  password_hash    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES platform.user_account(id) ON DELETE CASCADE,
  org_id      uuid,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_user_idx ON platform.session (user_id) WHERE revoked_at IS NULL;

CREATE TABLE platform.domain_event (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL,
  type         text NOT NULL,
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  version_id   uuid,
  actor_id     uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX domain_event_unprocessed_idx ON platform.domain_event (id) WHERE processed_at IS NULL;

-- platform.schema_migration is created by the migration runner before this file runs.

-- ---------------------------------------------------------------------------
-- Tenant tables (every table: org_id, FORCE RLS, USING + WITH CHECK)
-- ---------------------------------------------------------------------------
CREATE TYPE org_role AS ENUM ('owner', 'admin', 'announcer', 'contributor', 'member', 'auditor');
CREATE TYPE membership_status AS ENUM ('active', 'deactivated');
CREATE TYPE stream_kind AS ENUM ('company', 'department', 'team', 'project', 'private');
CREATE TYPE content_kind AS ENUM ('clip', 'audio', 'document', 'page', 'link');
CREATE TYPE content_state AS ENUM ('draft', 'published', 'retracted');  -- scheduled/expired are derived (ADR-0003)
CREATE TYPE version_status AS ENUM ('uploaded', 'processing', 'current', 'superseded', 'retracted', 'failed');
CREATE TYPE audience_kind AS ENUM ('org', 'user', 'group', 'stream');

CREATE TABLE org (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid GENERATED ALWAYS AS (id) STORED,   -- uniform RLS predicate
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  region     text NOT NULL DEFAULT 'self-host',
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_membership (
  org_id      uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES platform.user_account(id) ON DELETE CASCADE,
  role        org_role NOT NULL DEFAULT 'member',
  status      membership_status NOT NULL DEFAULT 'active',
  authz_epoch bigint NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE "group" (
  org_id      uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'local',           -- local | scim | directory
  external_id text,
  is_private  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, name)
);

CREATE TABLE stream (
  org_id     uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  kind       stream_kind NOT NULL,
  slug       text NOT NULL,
  name       text NOT NULL,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, slug)
);

-- Zanzibar-shaped tuples (ADR-0002). subject_relation is set for "userset" subjects such as stream#viewer.
CREATE TABLE relation_tuple (
  org_id           uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  object_type      text NOT NULL CHECK (object_type IN ('org', 'group', 'stream', 'content')),
  object_id        uuid NOT NULL,
  relation         text NOT NULL,
  subject_type     text NOT NULL CHECK (subject_type IN ('user', 'group', 'stream', 'org')),
  subject_id       uuid NOT NULL,
  subject_relation text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  PRIMARY KEY (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation)
);
CREATE INDEX relation_tuple_subject_idx ON relation_tuple (org_id, subject_type, subject_id);

-- Derived, real tables (not materialised views: they carry RLS).
CREATE TABLE user_group_membership (
  org_id   uuid NOT NULL,
  user_id  uuid NOT NULL,
  group_id uuid NOT NULL,
  PRIMARY KEY (org_id, user_id, group_id),
  FOREIGN KEY (org_id, group_id) REFERENCES "group"(org_id, id) ON DELETE CASCADE
);

CREATE TABLE user_stream_access (
  org_id    uuid NOT NULL,
  user_id   uuid NOT NULL,
  stream_id uuid NOT NULL,
  role      text NOT NULL CHECK (role IN ('viewer', 'contributor', 'moderator', 'owner')),
  PRIMARY KEY (org_id, user_id, stream_id),
  FOREIGN KEY (org_id, stream_id) REFERENCES stream(org_id, id) ON DELETE CASCADE
);
CREATE INDEX user_stream_access_stream_idx ON user_stream_access (org_id, stream_id);

CREATE TABLE content (
  org_id             uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  kind               content_kind NOT NULL,
  owner_id           uuid NOT NULL,
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  state              content_state NOT NULL DEFAULT 'draft',
  publish_at         timestamptz,
  expires_at         timestamptz,
  retracted_at       timestamptz,
  current_version_id uuid,
  content_epoch      bigint NOT NULL DEFAULT 1,
  media_key_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  review_requested   boolean NOT NULL DEFAULT false,     -- ADR-0002: drafts reach stream moderators only after review request
  event_tags         text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, owner_id) REFERENCES org_membership(org_id, user_id),
  CONSTRAINT content_published_requires_publish_at CHECK (state <> 'published' OR publish_at IS NOT NULL),
  CONSTRAINT content_retracted_requires_timestamp CHECK (state <> 'retracted' OR retracted_at IS NOT NULL)
);
CREATE INDEX content_feed_idx ON content (org_id, publish_at DESC) WHERE state = 'published';

CREATE TABLE content_version (
  org_id       uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  content_id   uuid NOT NULL,
  status       version_status NOT NULL DEFAULT 'uploaded',
  original_key text,
  checksum     bytea,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, content_id) REFERENCES content(org_id, id) ON DELETE CASCADE
);
CREATE INDEX content_version_content_idx ON content_version (org_id, content_id);
ALTER TABLE content ADD CONSTRAINT content_current_version_fk
  FOREIGN KEY (org_id, current_version_id) REFERENCES content_version(org_id, id) DEFERRABLE INITIALLY DEFERRED;

-- Denormalised audience rows derived from content tuples.
CREATE TABLE content_audience (
  org_id       uuid NOT NULL,
  content_id   uuid NOT NULL,
  kind         audience_kind NOT NULL,
  principal_id uuid NOT NULL,                        -- org id for kind 'org'
  PRIMARY KEY (org_id, content_id, kind, principal_id),
  FOREIGN KEY (org_id, content_id) REFERENCES content(org_id, id) ON DELETE CASCADE
);
CREATE INDEX content_audience_principal_idx ON content_audience (org_id, kind, principal_id);

CREATE TABLE chunk (
  org_id             uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  content_version_id uuid NOT NULL,
  content_id         uuid NOT NULL,
  locator            jsonb NOT NULL DEFAULT '{}'::jsonb,
  text               text NOT NULL,
  lang               text NOT NULL DEFAULT 'en',
  tsv                tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  embedding          vector(1024),
  embedding_model    text,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, content_version_id) REFERENCES content_version(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, content_id) REFERENCES content(org_id, id) ON DELETE CASCADE
);
CREATE INDEX chunk_tsv_idx ON chunk USING gin (tsv);
CREATE INDEX chunk_version_idx ON chunk (org_id, content_version_id);
-- HNSW index (cosine) is created in a later migration once embeddings are produced (M2), per org partials as needed.

CREATE TABLE user_content_state (
  org_id          uuid NOT NULL,
  user_id         uuid NOT NULL,
  content_id      uuid NOT NULL,
  first_viewed_at timestamptz,
  last_viewed_at  timestamptz,
  last_version_id uuid,
  title_snapshot  text,                              -- ADR-0005: title as seen, for opt-in notices
  completed_at    timestamptz,
  acked_version_id uuid,
  PRIMARY KEY (org_id, user_id, content_id),
  FOREIGN KEY (org_id, content_id) REFERENCES content(org_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_event (
  org_id     uuid NOT NULL,
  id         bigserial,
  actor_id   uuid,
  action     text NOT NULL,
  target     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);

-- ---------------------------------------------------------------------------
-- Per-org content epoch sequence (ADR-0004: a sequence, not a serialised row)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION org_epoch_seq_name(p_org uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'platform.org_epoch_' || replace(p_org::text, '-', '')
$$;

CREATE OR REPLACE FUNCTION org_create_epoch_seq() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'org_create_epoch_seq: org required'; END IF;
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %s START 1', org_epoch_seq_name(NEW.id));
  RETURN NEW;
END $$;
CREATE TRIGGER org_create_epoch_seq AFTER INSERT ON org FOR EACH ROW EXECUTE FUNCTION org_create_epoch_seq();

-- Internal: advances the org epoch without a context check. Used only by owner-run triggers; EXECUTE is
-- revoked from PUBLIC below so the application role cannot call it directly.
CREATE OR REPLACE FUNCTION org_epoch_advance(p_org uuid) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'org_epoch_advance: org required'; END IF;
  IF to_regclass(org_epoch_seq_name(p_org)) IS NULL THEN RETURN NULL; END IF;  -- org being deleted
  EXECUTE format('SELECT nextval(%L)', org_epoch_seq_name(p_org)) INTO v;
  RETURN v;
END $$;

-- Application-facing: requires the caller's tenant context to match.
CREATE OR REPLACE FUNCTION next_org_content_epoch(p_org uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL OR p_org <> app_org() THEN RAISE EXCEPTION 'org context mismatch'; END IF;
  RETURN org_epoch_advance(p_org);
END $$;

CREATE OR REPLACE FUNCTION org_drop_epoch_seq() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF OLD.org_id IS NULL THEN RAISE EXCEPTION 'org_drop_epoch_seq: org required'; END IF;
  EXECUTE format('DROP SEQUENCE IF EXISTS %s', org_epoch_seq_name(OLD.id));
  RETURN NULL;
END $$;
CREATE TRIGGER org_drop_epoch_seq AFTER DELETE ON org FOR EACH ROW EXECUTE FUNCTION org_drop_epoch_seq();

CREATE OR REPLACE FUNCTION current_org_content_epoch(p_org uuid) RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v bigint;
BEGIN
  IF p_org IS NULL OR p_org <> app_org() THEN RAISE EXCEPTION 'org context mismatch'; END IF;
  -- A fresh sequence reports last_value = 1 with is_called = false; report 0 until the first advance so the
  -- first content change is visible to epoch-keyed caches (ADR-0004).
  EXECUTE format('SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM %s', org_epoch_seq_name(p_org)) INTO v;
  RETURN v;
END $$;

-- ---------------------------------------------------------------------------
-- Authorization maintenance (ADR-0002): synchronous, org-filtered, trigger-driven.
-- Closure and access rows are recomputed for the affected principals inside the same transaction
-- as the tuple change; affected users' authz_epoch is bumped in that transaction.
-- ---------------------------------------------------------------------------

-- Users transitively in a group (bounded depth 4, cycles rejected at write time).
CREATE OR REPLACE FUNCTION authz_users_in_group(p_org uuid, p_group uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE g(id, depth) AS (
    SELECT p_group, 0
    UNION
    SELECT t.subject_id, g.depth + 1
    FROM relation_tuple t JOIN g ON t.org_id = p_org AND t.object_type = 'group' AND t.object_id = g.id
      AND t.relation = 'member' AND t.subject_type = 'group' AND g.depth < 4
  )
  SELECT DISTINCT t.subject_id
  FROM relation_tuple t JOIN g ON t.org_id = p_org AND t.object_type = 'group' AND t.object_id = g.id
  WHERE t.relation = 'member' AND t.subject_type = 'user'
$$;

-- Groups a user belongs to, transitively (parents of parents, depth 4).
CREATE OR REPLACE FUNCTION authz_groups_of_user(p_org uuid, p_user uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE g(id, depth) AS (
    SELECT t.object_id, 1 FROM relation_tuple t
    WHERE t.org_id = p_org AND t.object_type = 'group' AND t.relation = 'member'
      AND t.subject_type = 'user' AND t.subject_id = p_user
    UNION
    SELECT t.object_id, g.depth + 1 FROM relation_tuple t JOIN g ON t.org_id = p_org
      AND t.object_type = 'group' AND t.relation = 'member' AND t.subject_type = 'group' AND t.subject_id = g.id
      AND g.depth < 4
  )
  SELECT DISTINCT id FROM g
$$;

CREATE OR REPLACE FUNCTION authz_rebuild_user(p_org uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'authz_rebuild_user: org required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('authz:' || p_org::text), hashtext(p_user::text));
  DELETE FROM user_group_membership WHERE org_id = p_org AND user_id = p_user;
  IF NOT EXISTS (SELECT 1 FROM org_membership m WHERE m.org_id = p_org AND m.user_id = p_user AND m.status = 'active') THEN
    -- Deactivated or unknown members never hold derived access rows (ADR-0002 synchronous revocation).
    DELETE FROM user_stream_access WHERE org_id = p_org AND user_id = p_user;
    RETURN;
  END IF;
  INSERT INTO user_group_membership (org_id, user_id, group_id)
    SELECT p_org, p_user, g FROM authz_groups_of_user(p_org, p_user) g;

  DELETE FROM user_stream_access WHERE org_id = p_org AND user_id = p_user;
  INSERT INTO user_stream_access (org_id, user_id, stream_id, role)
    SELECT org_id, p_user, stream_id, role FROM (
      SELECT t.org_id, t.object_id AS stream_id, t.relation AS role,
             CASE t.relation WHEN 'owner' THEN 4 WHEN 'moderator' THEN 3 WHEN 'contributor' THEN 2 ELSE 1 END AS rank,
             row_number() OVER (PARTITION BY t.object_id ORDER BY
               CASE t.relation WHEN 'owner' THEN 4 WHEN 'moderator' THEN 3 WHEN 'contributor' THEN 2 ELSE 1 END DESC) AS rn
      FROM relation_tuple t
      WHERE t.org_id = p_org AND t.object_type = 'stream' AND t.relation IN ('viewer','contributor','moderator','owner')
        AND (
          (t.subject_type = 'user' AND t.subject_id = p_user)
          OR (t.subject_type = 'group' AND t.subject_id IN (SELECT group_id FROM user_group_membership WHERE org_id = p_org AND user_id = p_user))
          OR (t.subject_type = 'org' AND t.subject_relation = 'member'
              AND EXISTS (SELECT 1 FROM org_membership m WHERE m.org_id = p_org AND m.user_id = p_user AND m.status = 'active'))
        )
    ) s WHERE rn = 1;

  UPDATE org_membership SET authz_epoch = authz_epoch + 1, updated_at = now()
    WHERE org_id = p_org AND user_id = p_user;
END $$;

CREATE OR REPLACE FUNCTION authz_rebuild_group(p_org uuid, p_group uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE u uuid;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'authz_rebuild_group: org required'; END IF;
  -- Users currently recorded in the closure for this group, plus users now transitively in it.
  FOR u IN
    SELECT user_id FROM user_group_membership WHERE org_id = p_org AND group_id = p_group
    UNION
    SELECT authz_users_in_group(p_org, p_group)
  LOOP
    PERFORM authz_rebuild_user(p_org, u);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION authz_rebuild_stream(p_org uuid, p_stream uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE u uuid;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'authz_rebuild_stream: org required'; END IF;
  FOR u IN
    SELECT user_id FROM user_stream_access WHERE org_id = p_org AND stream_id = p_stream
    UNION
    SELECT t.subject_id FROM relation_tuple t WHERE t.org_id = p_org AND t.object_type = 'stream' AND t.object_id = p_stream AND t.subject_type = 'user'
    UNION
    SELECT authz_users_in_group(p_org, t.subject_id) FROM relation_tuple t WHERE t.org_id = p_org AND t.object_type = 'stream' AND t.object_id = p_stream AND t.subject_type = 'group'
    UNION
    SELECT m.user_id FROM org_membership m WHERE m.org_id = p_org AND m.status = 'active' AND EXISTS (
      SELECT 1 FROM relation_tuple t WHERE t.org_id = p_org AND t.object_type = 'stream' AND t.object_id = p_stream AND t.subject_type = 'org')
  LOOP
    PERFORM authz_rebuild_user(p_org, u);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION content_audience_sync(p_org uuid, p_content uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'content_audience_sync: org required'; END IF;
  DELETE FROM content_audience WHERE org_id = p_org AND content_id = p_content;
  INSERT INTO content_audience (org_id, content_id, kind, principal_id)
    SELECT DISTINCT t.org_id, t.object_id,
      CASE t.subject_type WHEN 'org' THEN 'org'::audience_kind WHEN 'user' THEN 'user' WHEN 'group' THEN 'group' WHEN 'stream' THEN 'stream' END,
      t.subject_id
    FROM relation_tuple t
    WHERE t.org_id = p_org AND t.object_type = 'content' AND t.object_id = p_content AND t.relation = 'viewer'
      AND ((t.subject_type = 'org' AND t.subject_relation = 'member') OR (t.subject_type = 'stream' AND t.subject_relation = 'viewer')
           OR (t.subject_type IN ('user', 'group') AND t.subject_relation = ''));
  UPDATE content SET content_epoch = content_epoch + 1, updated_at = now() WHERE org_id = p_org AND id = p_content;
  PERFORM org_epoch_advance(p_org);
END $$;

CREATE OR REPLACE FUNCTION relation_tuple_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE r relation_tuple;
BEGIN
  r := COALESCE(NEW, OLD);
  IF r.org_id IS NULL THEN RAISE EXCEPTION 'relation_tuple_changed: org required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('authz:' || r.org_id::text));
  IF r.object_type = 'group' THEN
    PERFORM authz_rebuild_group(r.org_id, r.object_id);
    IF r.subject_type = 'user' THEN PERFORM authz_rebuild_user(r.org_id, r.subject_id); END IF;
  ELSIF r.object_type = 'stream' THEN
    PERFORM authz_rebuild_stream(r.org_id, r.object_id);
  ELSIF r.object_type = 'content' THEN
    PERFORM content_audience_sync(r.org_id, r.object_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER relation_tuple_changed AFTER INSERT OR DELETE ON relation_tuple
  FOR EACH ROW EXECUTE FUNCTION relation_tuple_changed();

-- Deactivation revokes synchronously: drop derived access and bump the epoch.
CREATE OR REPLACE FUNCTION org_membership_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'org_membership_changed: org required'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'deactivated' AND OLD.status <> 'deactivated' THEN
    DELETE FROM user_stream_access WHERE org_id = NEW.org_id AND user_id = NEW.user_id;
    DELETE FROM user_group_membership WHERE org_id = NEW.org_id AND user_id = NEW.user_id;
    UPDATE platform.session SET revoked_at = now() WHERE user_id = NEW.user_id AND org_id = NEW.org_id AND revoked_at IS NULL;
    NEW.authz_epoch := NEW.authz_epoch + 1;
  ELSIF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status <> 'active') THEN
    -- Grants for a (re)activated member are rebuilt after the row exists (AFTER trigger below).
    NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER org_membership_changed BEFORE INSERT OR UPDATE ON org_membership
  FOR EACH ROW EXECUTE FUNCTION org_membership_changed();

CREATE OR REPLACE FUNCTION org_membership_activated() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'org_membership_activated: org required'; END IF;
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
    PERFORM authz_rebuild_user(NEW.org_id, NEW.user_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER org_membership_activated AFTER INSERT OR UPDATE ON org_membership
  FOR EACH ROW EXECUTE FUNCTION org_membership_activated();

CREATE OR REPLACE FUNCTION org_membership_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF OLD.org_id IS NULL THEN RAISE EXCEPTION 'org_membership_deleted: org required'; END IF;
  DELETE FROM user_stream_access WHERE org_id = OLD.org_id AND user_id = OLD.user_id;
  DELETE FROM user_group_membership WHERE org_id = OLD.org_id AND user_id = OLD.user_id;
  UPDATE platform.session SET revoked_at = now() WHERE user_id = OLD.user_id AND org_id = OLD.org_id AND revoked_at IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER org_membership_deleted AFTER DELETE ON org_membership
  FOR EACH ROW EXECUTE FUNCTION org_membership_deleted();

-- Content state changes bump epochs (ADR-0004).
CREATE OR REPLACE FUNCTION content_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'content_changed: org required'; END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.state IS DISTINCT FROM OLD.state OR NEW.publish_at IS DISTINCT FROM OLD.publish_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.retracted_at IS DISTINCT FROM OLD.retracted_at
    OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description OR NEW.event_tags IS DISTINCT FROM OLD.event_tags) THEN
    NEW.content_epoch := OLD.content_epoch + 1;
    NEW.updated_at := now();
    IF NEW.retracted_at IS NOT NULL AND OLD.retracted_at IS NULL THEN
      NEW.media_key_id := gen_random_uuid();   -- proxy-mode revocation handle (ADR-0003)
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER content_changed BEFORE UPDATE ON content FOR EACH ROW EXECUTE FUNCTION content_changed();

CREATE OR REPLACE FUNCTION content_changed_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'content_changed_after: org required'; END IF;
  IF TG_OP = 'INSERT' OR NEW.content_epoch <> OLD.content_epoch THEN
    PERFORM org_epoch_advance(NEW.org_id);
    IF NEW.retracted_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.retracted_at IS NULL) THEN
      UPDATE content_version SET status = 'retracted' WHERE org_id = NEW.org_id AND content_id = NEW.id AND status IN ('current','superseded','processing','uploaded');
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER content_changed_after AFTER INSERT OR UPDATE ON content FOR EACH ROW EXECUTE FUNCTION content_changed_after();

-- ---------------------------------------------------------------------------
-- Row-level security: FORCE on every tenant table, USING + WITH CHECK.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org','org_membership','group','stream','relation_tuple','user_group_membership',
                           'user_stream_access','content','content_version','content_audience','chunk',
                           'user_content_state','audit_event']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org()) WITH CHECK (org_id = app_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ourstream_app', t);
  END LOOP;
END $$;

-- org rows are readable by members; creation of an org happens through a definer function in the API layer (M1a).
-- Outbox writes go through a definer function bound to the caller's tenant context (ADR-0005); the app
-- role has no direct privileges on platform tables. Account and session access arrives with M1a through
-- definer functions as well.
CREATE OR REPLACE FUNCTION platform_emit_event(p_type text, p_subject_type text, p_subject_id uuid, p_version_id uuid, p_payload jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org(); v_id bigint;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'platform_emit_event: org context required'; END IF;
  INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, actor_id, payload)
    VALUES (v_org, p_type, p_subject_type, p_subject_id, p_version_id, app_user(), COALESCE(p_payload, '{}'::jsonb))
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE EXECUTE ON FUNCTION platform_emit_event(text, text, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_emit_event(text, text, uuid, uuid, jsonb) TO ourstream_app;

GRANT USAGE ON SCHEMA platform TO ourstream_app, ourstream_platform;
GRANT SELECT, UPDATE ON platform.domain_event TO ourstream_platform;
GRANT SELECT ON platform.schema_migration TO ourstream_platform;
GRANT USAGE ON SCHEMA public TO ourstream_app, ourstream_platform;
-- Fixed search paths so no role can shadow public tables through a "$user" schema (F6).
ALTER ROLE ourstream_app SET search_path = public, pg_catalog;
ALTER ROLE ourstream_platform SET search_path = public, pg_catalog;
REVOKE EXECUTE ON FUNCTION org_epoch_advance(uuid), authz_rebuild_user(uuid, uuid), authz_rebuild_group(uuid, uuid),
  authz_rebuild_stream(uuid, uuid), content_audience_sync(uuid, uuid), org_create_epoch_seq(), org_drop_epoch_seq(),
  relation_tuple_changed(), org_membership_changed(), org_membership_activated(), org_membership_deleted(), content_changed(), content_changed_after() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION next_org_content_epoch(uuid), current_org_content_epoch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_org(), app_user(), next_org_content_epoch(uuid), current_org_content_epoch(uuid), authz_users_in_group(uuid, uuid), authz_groups_of_user(uuid, uuid) TO ourstream_app;
GRANT USAGE, SELECT ON SEQUENCE audit_event_id_seq TO ourstream_app;
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ourstream_platform;   -- pg-boss owns its schema; no CREATE on the database
