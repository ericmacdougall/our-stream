-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0013 (M2a core): documents, embeddings and the permission-filtered retrieval substrate.
-- Spec: M2a (GoodQA work-tracker-automatic#35634), ADR-0002 (document gate) and docs/documents.md.
--
-- Forward-only, no transaction control (the runner owns the transaction). Non-transactional DDL
-- (CREATE INDEX CONCURRENTLY for a shadow pin) is run by the post-migrate index job, never here.
--
-- Rollback note (ADR-0012): this migration stays applied. docs/documents.md "Rollback procedure" lists the
-- SQL steps (kill switch, flag record, hide, previous build, restore). The functions below that replace
-- earlier definitions (content_publish 0011, content_retract 0002, platform_version_update 0004,
-- search_index_version 0009, platform_search_reindex 0009, platform_audience_of_content 0003,
-- platform_viewers_of_version 0002, platform_digest_items 0010) are what keeps the previous API and
-- worker build safe: documents cannot be published while the flag is off, an old worker cannot move a
-- document version, and old clip indexing still works.

-- ---------------------------------------------------------------------------
-- pgvector must provide iterative index scans (0.8.0 or later); fail closed below it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v text; parts int[];
BEGIN
  SELECT extversion INTO v FROM pg_extension WHERE extname = 'vector';
  IF v IS NULL THEN RAISE EXCEPTION 'migration 0013: pgvector is not installed'; END IF;
  parts := string_to_array(regexp_replace(v, '[^0-9.].*$', ''), '.')::int[];
  IF parts[1] < 0 OR (parts[1] = 0 AND COALESCE(parts[2], 0) < 8) THEN
    RAISE EXCEPTION 'migration 0013: pgvector % is too old; 0.8.0 or later (iterative scan) is required', v;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- content_version: parse attempt fence and upload-complete sequence
-- ---------------------------------------------------------------------------
ALTER TABLE content_version
  ADD COLUMN parse_attempt uuid,
  ADD COLUMN completed_seq bigint;
CREATE UNIQUE INDEX content_version_completed_seq_uidx ON content_version (org_id, content_id, completed_seq)
  WHERE completed_seq IS NOT NULL;

-- ---------------------------------------------------------------------------
-- chunk: ordinal and text hash. Nullable add, backfill, SET NOT NULL, then UNIQUE.
-- The hash is the SHA-256 of the UTF-8 bytes of NFC-normalised text, computed only by SQL
-- (convert_to is not IMMUTABLE, so a generated column is not possible).
-- ---------------------------------------------------------------------------
ALTER TABLE chunk ADD COLUMN ordinal integer, ADD COLUMN text_sha256 bytea;

UPDATE chunk SET text_sha256 = digest(convert_to(normalize(text, NFC), 'UTF8'), 'sha256');
UPDATE chunk k SET ordinal = r.rn
  FROM (SELECT org_id, id,
               row_number() OVER (
                 PARTITION BY org_id, content_version_id
                 ORDER BY CASE WHEN jsonb_typeof(locator -> 'start_ms') = 'number' THEN (locator ->> 'start_ms')::numeric END, id) AS rn
          FROM chunk) r
 WHERE k.org_id = r.org_id AND k.id = r.id;

ALTER TABLE chunk ALTER COLUMN ordinal SET NOT NULL, ALTER COLUMN text_sha256 SET NOT NULL;
ALTER TABLE chunk ADD CONSTRAINT chunk_version_ordinal_key UNIQUE (org_id, content_version_id, ordinal);
CREATE INDEX chunk_text_sha256_idx ON chunk (org_id, text_sha256);

CREATE OR REPLACE FUNCTION chunk_prepare() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'chunk_prepare: org required'; END IF;
  NEW.text_sha256 := digest(convert_to(normalize(NEW.text, NFC), 'UTF8'), 'sha256');
  IF TG_OP = 'INSERT' AND NEW.ordinal IS NULL THEN
    -- Serialise concurrent inserts for one version, then take the next ordinal.
    PERFORM 1 FROM content_version v WHERE v.org_id = NEW.org_id AND v.id = NEW.content_version_id FOR UPDATE;
    SELECT COALESCE(max(k.ordinal), 0) + 1 INTO NEW.ordinal FROM chunk k
     WHERE k.org_id = NEW.org_id AND k.content_version_id = NEW.content_version_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chunk_prepare BEFORE INSERT OR UPDATE OF text ON chunk FOR EACH ROW EXECUTE FUNCTION chunk_prepare();

-- ---------------------------------------------------------------------------
-- Migration 0009 repair: documents are never re-indexed by the transcript indexer (it would delete the
-- chunks a document parse wrote). Both chunk INSERTs now set ordinal and text_sha256.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_index_version(p_org uuid, p_version uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_content uuid; v_kind content_kind; v_transcript jsonb; v_lang text; seg jsonb; s_start integer; s_end integer; s_text text;
        w_start integer; w_end integer; w_text text := ''; v_n integer := 0;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'search_index_version: org required'; END IF;
  SELECT v.content_id, v.transcript, c.kind INTO v_content, v_transcript, v_kind
    FROM content_version v JOIN content c ON c.org_id = v.org_id AND c.id = v.content_id
   WHERE v.org_id = p_org AND v.id = p_version;
  IF v_content IS NULL THEN RETURN 0; END IF;
  IF v_kind = 'document' THEN RETURN 0; END IF;
  DELETE FROM chunk WHERE org_id = p_org AND content_version_id = p_version;
  IF v_transcript IS NULL OR jsonb_typeof(v_transcript -> 'segments') <> 'array' THEN RETURN 0; END IF;
  v_lang := left(COALESCE(v_transcript ->> 'language', 'en'), 16);
  FOR seg IN SELECT value FROM jsonb_array_elements(v_transcript -> 'segments')
             ORDER BY COALESCE(round((value ->> 'start_ms')::numeric), 0) LOOP
    s_text := btrim(regexp_replace(COALESCE(seg ->> 'text', ''), '\s+', ' ', 'g'));
    CONTINUE WHEN s_text = '';
    s_start := GREATEST(0, COALESCE(round((seg ->> 'start_ms')::numeric)::integer, 0));
    s_end := GREATEST(s_start, COALESCE(round((seg ->> 'end_ms')::numeric)::integer, s_start));
    IF w_start IS NOT NULL AND (s_end - w_start > 20000 OR length(w_text) + 1 + length(s_text) > 400) THEN
      INSERT INTO chunk (org_id, content_version_id, content_id, locator, text, lang, ordinal, text_sha256)
        VALUES (p_org, p_version, v_content, jsonb_build_object('kind', 'transcript', 'start_ms', w_start, 'end_ms', w_end), w_text, v_lang,
                v_n + 1, digest(convert_to(normalize(w_text, NFC), 'UTF8'), 'sha256'));
      v_n := v_n + 1;
      w_start := NULL;
      w_text := '';
    END IF;
    IF w_start IS NULL THEN
      w_start := s_start;
      w_text := s_text;
    ELSE
      w_text := w_text || ' ' || s_text;
    END IF;
    w_end := s_end;
  END LOOP;
  IF w_start IS NOT NULL THEN
    INSERT INTO chunk (org_id, content_version_id, content_id, locator, text, lang, ordinal, text_sha256)
      VALUES (p_org, p_version, v_content, jsonb_build_object('kind', 'transcript', 'start_ms', w_start, 'end_ms', w_end), w_text, v_lang,
              v_n + 1, digest(convert_to(normalize(w_text, NFC), 'UTF8'), 'sha256'));
    v_n := v_n + 1;
  END IF;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION platform_search_reindex(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v uuid; v_n integer := 0;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_search_reindex: org required'; END IF;
  FOR v IN SELECT cv.id FROM content_version cv JOIN content c ON c.org_id = cv.org_id AND c.id = cv.content_id
            WHERE cv.org_id = p_org AND cv.status = 'current' AND c.kind <> 'document' LOOP
    v_n := v_n + search_index_version(p_org, v);
  END LOOP;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- Embedding pin (platform schema, no app grant), kill switch, flag and hide records
-- ---------------------------------------------------------------------------
CREATE TABLE platform.embedding_pin (
  id         uuid PRIMARY KEY,
  model      text NOT NULL,
  dims       integer NOT NULL CHECK (dims = 1024),
  state      text NOT NULL CHECK (state IN ('active', 'shadow', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- At most one active pin.
CREATE UNIQUE INDEX embedding_pin_one_active_idx ON platform.embedding_pin ((true)) WHERE state = 'active';
-- The default pin has a fixed deterministic id (its HNSW index below is partial on this literal).
INSERT INTO platform.embedding_pin (id, model, dims, state)
  VALUES ('5a7e0001-0000-4000-8000-000000000001', 'Qwen3-Embedding-0.6B', 1024, 'active');

CREATE TABLE platform.embedding_pin_ready (
  pin_id            uuid PRIMARY KEY REFERENCES platform.embedding_pin(id) ON DELETE CASCADE,
  index_valid       boolean NOT NULL,
  coverage_complete boolean NOT NULL,
  checked_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.documents_kill_switch (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  engaged    boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform.documents_kill_switch (singleton, engaged) VALUES (true, false);

CREATE TABLE platform.documents_flag_record (
  org_id        uuid PRIMARY KEY REFERENCES org(id) ON DELETE CASCADE,
  prior_present boolean NOT NULL,
  prior_value   jsonb,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  restored_at   timestamptz
);

CREATE TABLE platform.documents_hide_record (
  org_id            uuid NOT NULL,
  content_id        uuid NOT NULL,
  prior_publish_at  timestamptz NOT NULL,
  prior_expires_at  timestamptz,
  hidden_updated_at timestamptz NOT NULL,
  hidden_at         timestamptz NOT NULL DEFAULT now(),
  restored_at       timestamptz,
  skip_reason       text,
  PRIMARY KEY (org_id, content_id),
  FOREIGN KEY (org_id, content_id) REFERENCES content(org_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- embedding: vectors keyed by (org, text hash, pin); app role has SELECT only
-- ---------------------------------------------------------------------------
CREATE TABLE embedding (
  org_id      uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  text_sha256 bytea NOT NULL,
  pin_id      uuid NOT NULL REFERENCES platform.embedding_pin(id),
  vector      vector(1024) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, text_sha256, pin_id)
);
ALTER TABLE embedding ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON embedding USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT ON embedding TO ourstream_app;
-- One HNSW index per pin, partial on the literal pin id (an index predicate must be immutable). Retrieval
-- writes the active pin id into its SQL text as a literal so the planner can match this index.
CREATE INDEX embedding_hnsw_5a7e0001 ON embedding USING hnsw (vector vector_cosine_ops)
  WHERE pin_id = '5a7e0001-0000-4000-8000-000000000001'::uuid;

-- The app role cannot read the pin table, so the pin-state check runs as definer.
CREATE OR REPLACE FUNCTION embedding_check_pin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_state text;
BEGIN
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'embedding_check_pin: org required'; END IF;
  SELECT p.state INTO v_state FROM platform.embedding_pin p WHERE p.id = NEW.pin_id;
  IF v_state IS NULL OR v_state NOT IN ('active', 'shadow') THEN
    RAISE EXCEPTION 'embedding_check_pin: pin is not active or shadow (org %)', NEW.org_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_check_pin BEFORE INSERT OR UPDATE OF pin_id ON embedding FOR EACH ROW EXECUTE FUNCTION embedding_check_pin();

-- ---------------------------------------------------------------------------
-- Flag and kill switch
-- ---------------------------------------------------------------------------
-- Internal, unchecked: the worker has no tenant context, so definer functions that copy the visibility
-- rule call this one. Not granted to any role (definer callers run as the owner).
CREATE OR REPLACE FUNCTION documents_enabled_unchecked(p_org uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'documents_enabled_unchecked: org required'; END IF;
  RETURN NOT COALESCE((SELECT k.engaged FROM platform.documents_kill_switch k), true)
     AND COALESCE((SELECT o.settings ->> 'documents_enabled' = 'true' FROM org o WHERE o.id = p_org), false);
END $$;

-- Application-facing: combines the deployment kill switch and the org flag (an absent key is off). Evaluated
-- once per query as an uncorrelated InitPlan: (SELECT platform_documents_enabled($org)).
CREATE OR REPLACE FUNCTION platform_documents_enabled(p_org uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM app_org() THEN RAISE EXCEPTION 'platform_documents_enabled: org context mismatch'; END IF;
  RETURN documents_enabled_unchecked(p_org);
END $$;

-- The settings route reads the switch alone so it can refuse to turn the flag on during a rollback window.
CREATE OR REPLACE FUNCTION platform_documents_kill_switch_engaged() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF current_user IS NULL THEN RAISE EXCEPTION 'platform_documents_kill_switch_engaged: platform-scope, no tenant data'; END IF;
  RETURN COALESCE((SELECT k.engaged FROM platform.documents_kill_switch k), true);
END $$;

-- Every flag change advances the org epoch so cached permitted-id sets are not used across it.
CREATE OR REPLACE FUNCTION org_documents_flag_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'org_documents_flag_changed: org required'; END IF;
  PERFORM org_epoch_advance(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER org_documents_flag_changed AFTER UPDATE OF settings ON org FOR EACH ROW
  WHEN (OLD.settings -> 'documents_enabled' IS DISTINCT FROM NEW.settings -> 'documents_enabled')
  EXECUTE FUNCTION org_documents_flag_changed();

CREATE OR REPLACE FUNCTION platform_documents_kill_switch_set(p_engaged boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE o uuid; n integer := 0;
BEGIN
  IF p_engaged IS NULL THEN RAISE EXCEPTION 'platform_documents_kill_switch_set: cross-org by design, value required'; END IF;
  UPDATE platform.documents_kill_switch SET engaged = p_engaged, changed_at = now();
  FOR o IN SELECT id FROM org LOOP
    PERFORM org_epoch_advance(o);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Writes the deployment default for orgs that lack the key (startup reconcile; orgs that existed before
-- the migration stay off until an admin or this call sets them).
CREATE OR REPLACE FUNCTION platform_documents_flag_init_missing(p_default boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE n integer;
BEGIN
  IF p_default IS NULL THEN RAISE EXCEPTION 'platform_documents_flag_init_missing: cross-org by design, value required'; END IF;
  UPDATE org SET settings = settings || jsonb_build_object('documents_enabled', p_default) WHERE NOT (settings ? 'documents_enabled');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Rollback step 1: record every org's current value, then set the flag for all orgs. Re-running while an
-- unrestored record exists keeps the original record.
CREATE OR REPLACE FUNCTION platform_documents_flag_set_all(p_enabled boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE n integer;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'platform_documents_flag_set_all: cross-org by design, value required'; END IF;
  IF NOT p_enabled THEN
    INSERT INTO platform.documents_flag_record (org_id, prior_present, prior_value)
      SELECT o.id, o.settings ? 'documents_enabled', o.settings -> 'documents_enabled' FROM org o
      ON CONFLICT (org_id) DO UPDATE
        SET prior_present = EXCLUDED.prior_present, prior_value = EXCLUDED.prior_value, recorded_at = now(), restored_at = NULL
        WHERE platform.documents_flag_record.restored_at IS NOT NULL;
  END IF;
  UPDATE org SET settings = settings || jsonb_build_object('documents_enabled', p_enabled);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Roll-forward: restore the recorded per-org values (over any admin change made since; accepted).
CREATE OR REPLACE FUNCTION platform_documents_flag_restore_all() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE r platform.documents_flag_record; n integer := 0;
BEGIN
  IF current_user IS NULL THEN RAISE EXCEPTION 'platform_documents_flag_restore_all: cross-org by design'; END IF;
  FOR r IN SELECT * FROM platform.documents_flag_record WHERE restored_at IS NULL ORDER BY org_id FOR UPDATE LOOP
    IF r.prior_present THEN
      UPDATE org SET settings = settings || jsonb_build_object('documents_enabled', r.prior_value) WHERE id = r.org_id;
    ELSE
      UPDATE org SET settings = settings - 'documents_enabled' WHERE id = r.org_id;
    END IF;
    UPDATE platform.documents_flag_record SET restored_at = now() WHERE org_id = r.org_id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Rollback step 2: hide documents that were published (live or scheduled). Draft documents are already
-- hidden by the flag and the publish guard and are never recorded, so a restore can never publish a
-- document that was never published. Retraction is not used (it is terminal).
CREATE OR REPLACE FUNCTION platform_documents_hide() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE n integer; o uuid;
BEGIN
  IF current_user IS NULL THEN RAISE EXCEPTION 'platform_documents_hide: cross-org by design'; END IF;
  WITH tgt AS (
    SELECT c.org_id, c.id, c.publish_at, c.expires_at FROM content c
     WHERE c.kind = 'document' AND c.state = 'published' AND c.retracted_at IS NULL AND c.publish_at IS NOT NULL
     FOR UPDATE),
  upd AS (
    UPDATE content c SET state = 'draft', publish_at = NULL, expires_at = NULL
      FROM tgt WHERE c.org_id = tgt.org_id AND c.id = tgt.id
    RETURNING c.org_id, c.id, c.updated_at),
  rec AS (
    INSERT INTO platform.documents_hide_record (org_id, content_id, prior_publish_at, prior_expires_at, hidden_updated_at)
      SELECT upd.org_id, upd.id, tgt.publish_at, tgt.expires_at, upd.updated_at FROM upd JOIN tgt ON tgt.org_id = upd.org_id AND tgt.id = upd.id
      ON CONFLICT (org_id, content_id) DO UPDATE
        SET prior_publish_at = EXCLUDED.prior_publish_at, prior_expires_at = EXCLUDED.prior_expires_at,
            hidden_updated_at = EXCLUDED.hidden_updated_at, hidden_at = now(), restored_at = NULL, skip_reason = NULL
      RETURNING org_id)
  SELECT count(*) INTO n FROM rec;
  FOR o IN SELECT DISTINCT h.org_id FROM platform.documents_hide_record h WHERE h.restored_at IS NULL AND h.hidden_at = now() LOOP
    PERFORM org_epoch_advance(o);
    INSERT INTO audit_event (org_id, actor_id, action, target)
      SELECT h.org_id, NULL, 'documents.hidden', jsonb_build_object('count', count(*))
        FROM platform.documents_hide_record h WHERE h.org_id = o AND h.hidden_at = now() GROUP BY h.org_id;
  END LOOP;
  RETURN n;
END $$;

-- Roll-forward: restore recorded documents that are still draft, not retracted and unmodified since the
-- hide. Marks restored rows, is idempotent, re-emits content.published (the notification layer dedupes
-- by published:<version>) or the schedule events for a still-future publish_at.
CREATE OR REPLACE FUNCTION platform_documents_restore()
RETURNS TABLE (org_id uuid, content_id uuid, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE r platform.documents_hide_record; c record; v_out text; v_org uuid;
BEGIN
  IF current_user IS NULL THEN RAISE EXCEPTION 'platform_documents_restore: cross-org by design'; END IF;
  FOR r IN SELECT * FROM platform.documents_hide_record h WHERE h.restored_at IS NULL ORDER BY h.org_id, h.content_id LOOP
    SELECT x.state, x.retracted_at, x.updated_at, x.current_version_id INTO c
      FROM content x WHERE x.org_id = r.org_id AND x.id = r.content_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF c.retracted_at IS NOT NULL OR c.state = 'retracted' THEN v_out := 'skipped_retracted';
    ELSIF c.state <> 'draft' THEN v_out := 'skipped_not_draft';
    ELSIF c.updated_at IS DISTINCT FROM r.hidden_updated_at THEN v_out := 'skipped_modified';
    ELSE v_out := 'restored';
    END IF;
    IF v_out = 'restored' THEN
      UPDATE content SET state = 'published', publish_at = r.prior_publish_at, expires_at = r.prior_expires_at
       WHERE content.org_id = r.org_id AND content.id = r.content_id;
      UPDATE platform.documents_hide_record h SET restored_at = now(), skip_reason = NULL
       WHERE h.org_id = r.org_id AND h.content_id = r.content_id;
      IF r.prior_publish_at <= now() AND (r.prior_expires_at IS NULL OR r.prior_expires_at > now()) THEN
        IF c.current_version_id IS NOT NULL THEN
          INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload)
            VALUES (r.org_id, 'content.published', 'content', r.content_id, c.current_version_id, '{"source":"documents_restore"}'::jsonb);
        END IF;
      ELSIF r.prior_publish_at > now() THEN
        INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload)
          VALUES (r.org_id, 'content.scheduled', 'content', r.content_id, c.current_version_id, '{"source":"documents_restore"}'::jsonb);
      END IF;
      IF r.prior_expires_at IS NOT NULL AND r.prior_expires_at > now() THEN
        INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload)
          VALUES (r.org_id, 'content.expiry_scheduled', 'content', r.content_id, c.current_version_id, '{"source":"documents_restore"}'::jsonb);
      END IF;
    ELSE
      UPDATE platform.documents_hide_record h SET skip_reason = v_out WHERE h.org_id = r.org_id AND h.content_id = r.content_id;
    END IF;
    org_id := r.org_id; content_id := r.content_id; outcome := v_out;
    RETURN NEXT;
  END LOOP;
  FOR v_org IN SELECT DISTINCT h.org_id FROM platform.documents_hide_record h WHERE h.restored_at = now() LOOP
    PERFORM org_epoch_advance(v_org);
    INSERT INTO audit_event (org_id, actor_id, action, target)
      SELECT h.org_id, NULL, 'documents.restored', jsonb_build_object('count', count(*))
        FROM platform.documents_hide_record h WHERE h.org_id = v_org AND h.restored_at = now() GROUP BY h.org_id;
  END LOOP;
  RETURN;
END $$;

-- ---------------------------------------------------------------------------
-- content_publish (from 0011): a draft-to-published transition for a document is refused while the
-- documents flag (or the kill switch) is off. Re-publishing an already published document stays allowed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION content_publish(p_content uuid, p_publish_at timestamptz, p_expires_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org(); v_kind content_kind; v_state content_state;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'content_publish: org context required'; END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= COALESCE(p_publish_at, now()) THEN
    RAISE EXCEPTION 'content_publish: expires_at must be after publish_at';
  END IF;
  SELECT c.kind, c.state INTO v_kind, v_state FROM content c WHERE c.org_id = v_org AND c.id = p_content FOR UPDATE;
  IF NOT FOUND OR v_state NOT IN ('draft', 'published') THEN RAISE EXCEPTION 'content_publish: content not found or retracted'; END IF;
  IF v_kind = 'document' AND v_state = 'draft' AND NOT documents_enabled_unchecked(v_org) THEN
    RAISE EXCEPTION 'content_publish: feature_disabled: documents are not enabled';
  END IF;
  UPDATE content SET state = 'published', publish_at = date_trunc('milliseconds', COALESCE(p_publish_at, now())), expires_at = p_expires_at, retracted_at = NULL
   WHERE org_id = v_org AND id = p_content AND state IN ('draft', 'published');
  IF NOT FOUND THEN RAISE EXCEPTION 'content_publish: content not found or retracted'; END IF;
END $$;

-- content_retract (from 0002): also rotates the parse attempt so a late worker's attempt id no longer
-- matches. The UPDATE on content takes the row lock first; the versions are retracted by the existing
-- content_changed_after trigger.
CREATE OR REPLACE FUNCTION content_retract(p_content uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'content_retract: org context required'; END IF;
  UPDATE content SET state = 'retracted', retracted_at = now() WHERE org_id = v_org AND id = p_content AND state <> 'retracted';
  IF NOT FOUND THEN RAISE EXCEPTION 'content_retract: content not found or already retracted'; END IF;
  UPDATE content_version SET parse_attempt = NULL WHERE org_id = v_org AND content_id = p_content AND parse_attempt IS NOT NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Document version lifecycle. Lock order everywhere: content row first, then version row.
-- ---------------------------------------------------------------------------
-- Internal: marks a non-terminal version failed. Not granted.
CREATE OR REPLACE FUNCTION document_mark_failed(p_org uuid, p_version uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'document_mark_failed: org required'; END IF;
  UPDATE content_version SET status = 'failed', processing_error = left(COALESCE(p_reason, 'failed'), 200), parse_attempt = NULL,
         processing_step = COALESCE(processing_step, 'failed')
   WHERE org_id = p_org AND id = p_version AND status IN ('uploaded', 'processing');
  RETURN FOUND;
END $$;

-- App role, upload COMPLETE for a document version: under the content lock, assigns the completion
-- sequence and rotates every other non-terminal (completed) version: parse_attempt NULL and failed with
-- reason superseded, so a late worker of an older version can neither finish nor linger in processing.
-- A version still awaiting its upload (an abandoned replace init) is never rotated.
CREATE OR REPLACE FUNCTION document_upload_complete(p_content uuid, p_version uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_org uuid := app_org(); v_kind content_kind; v_retracted timestamptz; v_status version_status; v_step text; v_seq bigint;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'document_upload_complete: org context required'; END IF;
  SELECT c.kind, c.retracted_at INTO v_kind, v_retracted FROM content c WHERE c.org_id = v_org AND c.id = p_content FOR UPDATE;
  IF NOT FOUND OR v_kind <> 'document' THEN RAISE EXCEPTION 'document_upload_complete: document not found'; END IF;
  IF v_retracted IS NOT NULL THEN RAISE EXCEPTION 'document_upload_complete: content not found or retracted'; END IF;
  SELECT v.status, v.processing_step INTO v_status, v_step FROM content_version v
   WHERE v.org_id = v_org AND v.id = p_version AND v.content_id = p_content FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_upload_complete: version not found'; END IF;
  IF v_status <> 'uploaded' OR v_step IS DISTINCT FROM 'awaiting_upload' THEN
    RAISE EXCEPTION 'document_upload_complete: not awaiting upload';
  END IF;
  SELECT COALESCE(max(v.completed_seq), 0) + 1 INTO v_seq FROM content_version v WHERE v.org_id = v_org AND v.content_id = p_content;
  UPDATE content_version SET processing_step = 'uploaded', completed_seq = v_seq WHERE org_id = v_org AND id = p_version;
  UPDATE content_version SET parse_attempt = NULL, status = 'failed', processing_error = 'superseded'
   WHERE org_id = v_org AND content_id = p_content AND id <> p_version
     AND status IN ('uploaded', 'processing') AND processing_step IS DISTINCT FROM 'awaiting_upload';
  RETURN v_seq;
END $$;

-- Platform: atomic claim. Returns the fresh attempt id, or NULL when the claim is refused (version not
-- uploaded or processing, still awaiting its upload, content retracted, not a document): the worker
-- acknowledges the job without retry. A new claim replaces the earlier attempt, which fences a dead worker.
CREATE OR REPLACE FUNCTION platform_document_claim(p_org uuid, p_version uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_content uuid; v_kind content_kind; v_retracted timestamptz; v_status version_status; v_step text; v_attempt uuid;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_document_claim: org required'; END IF;
  SELECT v.content_id INTO v_content FROM content_version v WHERE v.org_id = p_org AND v.id = p_version;
  IF v_content IS NULL THEN RETURN NULL; END IF;
  SELECT c.kind, c.retracted_at INTO v_kind, v_retracted FROM content c WHERE c.org_id = p_org AND c.id = v_content FOR UPDATE;
  IF v_kind IS DISTINCT FROM 'document' OR v_retracted IS NOT NULL THEN RETURN NULL; END IF;
  SELECT v.status, v.processing_step INTO v_status, v_step FROM content_version v WHERE v.org_id = p_org AND v.id = p_version FOR UPDATE;
  IF v_status NOT IN ('uploaded', 'processing') OR v_step IS NOT DISTINCT FROM 'awaiting_upload' THEN RETURN NULL; END IF;
  v_attempt := gen_random_uuid();
  UPDATE content_version SET status = 'processing', parse_attempt = v_attempt, processing_step = 'claimed', processing_error = NULL
   WHERE org_id = p_org AND id = p_version;
  RETURN v_attempt;
END $$;

-- Platform: attempt-guarded step and failure write. A NULL or non-matching attempt is stale; current,
-- retracted, superseded and failed versions are terminal. A non-null error marks the version failed.
-- Returns 'ok' or 'stale'.
CREATE OR REPLACE FUNCTION platform_document_step(p_org uuid, p_version uuid, p_attempt uuid, p_step text, p_error text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_content uuid; v_status version_status; v_cur uuid; v_step text;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_document_step: org required'; END IF;
  IF p_attempt IS NULL THEN RETURN 'stale'; END IF;
  SELECT v.content_id INTO v_content FROM content_version v WHERE v.org_id = p_org AND v.id = p_version;
  IF v_content IS NULL THEN RETURN 'stale'; END IF;
  PERFORM 1 FROM content c WHERE c.org_id = p_org AND c.id = v_content AND c.kind = 'document' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  SELECT v.status, v.parse_attempt, v.processing_step INTO v_status, v_cur, v_step FROM content_version v
   WHERE v.org_id = p_org AND v.id = p_version FOR UPDATE;
  IF v_status NOT IN ('uploaded', 'processing') OR v_cur IS DISTINCT FROM p_attempt OR v_step IS NOT DISTINCT FROM 'awaiting_upload' THEN
    RETURN 'stale';
  END IF;
  IF p_error IS NOT NULL THEN
    UPDATE content_version SET status = 'failed', processing_error = left(p_error, 200), parse_attempt = NULL,
           processing_step = COALESCE(p_step, processing_step)
     WHERE org_id = p_org AND id = p_version;
  ELSE
    UPDATE content_version SET status = 'processing', processing_step = COALESCE(p_step, processing_step)
     WHERE org_id = p_org AND id = p_version;
  END IF;
  RETURN 'ok';
END $$;

-- Platform: fail a version without an attempt id (attestation unavailable, a refusal before the claim, or
-- a reaper). Allowed only while uploaded or processing and not awaiting its upload. Returns whether it failed.
CREATE OR REPLACE FUNCTION platform_document_fail(p_org uuid, p_version uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_content uuid; v_status version_status; v_step text;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_document_fail: org required'; END IF;
  SELECT v.content_id INTO v_content FROM content_version v WHERE v.org_id = p_org AND v.id = p_version;
  IF v_content IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM content c WHERE c.org_id = p_org AND c.id = v_content AND c.kind = 'document' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT v.status, v.processing_step INTO v_status, v_step FROM content_version v WHERE v.org_id = p_org AND v.id = p_version FOR UPDATE;
  IF v_status NOT IN ('uploaded', 'processing') OR v_step IS NOT DISTINCT FROM 'awaiting_upload' THEN RETURN false; END IF;
  RETURN document_mark_failed(p_org, p_version, p_reason);
END $$;

-- Platform: the one finish. In one transaction, content lock then version lock; requires status uploaded or
-- processing, the claimed attempt, content not retracted and this version the newest completed non-failed
-- version of its content (ordered by completed_seq). Stale finisher: marks its own version failed
-- ('superseded') when it lost to a later complete, otherwise writes nothing. Then inserts the chunks and
-- performs the existing current switch and the 0004 announcement.
-- p_chunks: jsonb array of {"locator": {...}, "text": "...", "lang": "en"}; ordinals follow array order.
-- Returns 'ok', 'stale' or 'failed' (no extractable text, or limits exceeded; the version is failed).
CREATE OR REPLACE FUNCTION platform_document_finish(p_org uuid, p_version uuid, p_attempt uuid, p_chunks jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_content uuid; v_kind content_kind; v_state content_state; v_publish_at timestamptz; v_expires_at timestamptz; v_retracted timestamptz;
        v_status version_status; v_cur uuid; v_step text; v_seq bigint; v_n integer; v_bad integer; v_big integer;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_document_finish: org required'; END IF;
  IF p_attempt IS NULL THEN RETURN 'stale'; END IF;
  SELECT v.content_id INTO v_content FROM content_version v WHERE v.org_id = p_org AND v.id = p_version;
  IF v_content IS NULL THEN RETURN 'stale'; END IF;
  SELECT c.kind, c.state, c.publish_at, c.expires_at, c.retracted_at INTO v_kind, v_state, v_publish_at, v_expires_at, v_retracted
    FROM content c WHERE c.org_id = p_org AND c.id = v_content FOR UPDATE;
  IF v_kind IS DISTINCT FROM 'document' OR v_retracted IS NOT NULL THEN RETURN 'stale'; END IF;
  SELECT v.status, v.parse_attempt, v.processing_step, v.completed_seq INTO v_status, v_cur, v_step, v_seq
    FROM content_version v WHERE v.org_id = p_org AND v.id = p_version FOR UPDATE;
  IF v_status NOT IN ('uploaded', 'processing') OR v_cur IS DISTINCT FROM p_attempt OR v_step IS NOT DISTINCT FROM 'awaiting_upload' THEN
    RETURN 'stale';
  END IF;
  -- Stale when a later complete exists among the live versions of this content.
  IF EXISTS (SELECT 1 FROM content_version w
              WHERE w.org_id = p_org AND w.content_id = v_content AND w.id <> p_version
                AND w.status IN ('uploaded', 'processing', 'current') AND w.processing_step IS DISTINCT FROM 'awaiting_upload'
                AND w.completed_seq IS NOT NULL AND (v_seq IS NULL OR w.completed_seq > v_seq)) THEN
    PERFORM document_mark_failed(p_org, p_version, 'superseded');
    RETURN 'stale';
  END IF;
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
    PERFORM document_mark_failed(p_org, p_version, 'no_text');
    RETURN 'failed';
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE jsonb_typeof(e.value) <> 'object' OR jsonb_typeof(e.value -> 'text') IS DISTINCT FROM 'string'
                            OR btrim(e.value ->> 'text') = ''),
         count(*) FILTER (WHERE length(e.value ->> 'text') > 8000)
    INTO v_n, v_bad, v_big FROM jsonb_array_elements(p_chunks) e;
  IF v_n = 0 OR v_bad > 0 THEN
    PERFORM document_mark_failed(p_org, p_version, 'no_text');
    RETURN 'failed';
  END IF;
  IF v_n > 20000 OR v_big > 0 THEN
    PERFORM document_mark_failed(p_org, p_version, 'chunk_limit');
    RETURN 'failed';
  END IF;
  -- Shared advisory lock: embedding garbage collection for this org waits for this transaction, so it can
  -- never delete a vector that a chunk written here is about to reference.
  PERFORM pg_advisory_xact_lock_shared(hashtext('embedding_gc:' || p_org::text));
  DELETE FROM chunk WHERE org_id = p_org AND content_version_id = p_version;
  INSERT INTO chunk (org_id, content_version_id, content_id, locator, text, lang, ordinal)
    SELECT p_org, p_version, v_content, COALESCE(e.value -> 'locator', '{}'::jsonb), e.value ->> 'text',
           left(COALESCE(NULLIF(e.value ->> 'lang', ''), 'en'), 16), e.ord::integer
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord);
  UPDATE content_version SET status = 'current', processing_step = 'done', processing_error = NULL, parse_attempt = NULL, processed_at = now()
   WHERE org_id = p_org AND id = p_version;
  UPDATE content_version SET status = 'superseded' WHERE org_id = p_org AND content_id = v_content AND id <> p_version AND status = 'current';
  UPDATE content SET current_version_id = p_version WHERE org_id = p_org AND id = v_content;
  PERFORM org_epoch_advance(p_org);
  IF v_state = 'published' AND v_publish_at IS NOT NULL AND v_publish_at <= now()
     AND (v_expires_at IS NULL OR v_expires_at > now()) AND documents_enabled_unchecked(p_org)
     AND NOT EXISTS (SELECT 1 FROM platform.domain_event e WHERE e.org_id = p_org AND e.type = 'content.published' AND e.subject_id = v_content AND e.version_id = p_version) THEN
    INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload)
      VALUES (p_org, 'content.published', 'content', v_content, p_version, '{"source":"processing_complete"}'::jsonb);
  END IF;
  RETURN 'ok';
END $$;

-- platform_version_update (from 0004): for documents it accepts only a failure write, and only while the
-- version is uploaded or processing; every other status write is a silent no-op. An old worker therefore
-- can never move a document version.
CREATE OR REPLACE FUNCTION platform_version_update(p_org uuid, p_version uuid, p_status version_status, p_step text, p_error text, p_assets jsonb, p_transcript jsonb, p_meta jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_content uuid; v_kind content_kind; v_state content_state; v_publish_at timestamptz; v_expires_at timestamptz; v_retracted timestamptz;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_version_update: org required'; END IF;
  SELECT c.kind INTO v_kind FROM content_version v JOIN content c ON c.org_id = v.org_id AND c.id = v.content_id
   WHERE v.org_id = p_org AND v.id = p_version;
  IF v_kind = 'document' THEN
    IF p_status IS NOT DISTINCT FROM 'failed' THEN
      PERFORM document_mark_failed(p_org, p_version, p_error);
    END IF;
    RETURN;
  END IF;
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

-- Event routing: dispatchEvent runs on the platform client with no tenant context, so the content kind
-- comes through this definer function (document versions go to the document queue, never media.process).
CREATE OR REPLACE FUNCTION platform_content_kind(p_org uuid, p_content uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_content_kind: org required'; END IF;
  RETURN (SELECT c.kind::text FROM content c WHERE c.org_id = p_org AND c.id = p_content);
END $$;

-- ---------------------------------------------------------------------------
-- Copies of the readerVisible rule that never call readerVisibleSql get the document clause:
-- (kind <> 'document' OR (documents enabled AND the content's current version is 'current')).
-- platform_audience_of_content (from 0003), platform_viewers_of_version (from 0002),
-- platform_digest_items (from 0010).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_audience_of_content(p_org uuid, p_content uuid)
RETURNS TABLE (user_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_audience_of_content: org required'; END IF;
  RETURN QUERY SELECT m.user_id FROM org_membership m
  JOIN content c ON c.org_id = m.org_id AND c.id = p_content
  WHERE m.org_id = p_org AND m.status = 'active'
    AND c.state = 'published' AND c.publish_at IS NOT NULL AND c.publish_at <= now()
    AND (c.expires_at IS NULL OR c.expires_at > now()) AND c.retracted_at IS NULL
    AND (c.kind <> 'document' OR (documents_enabled_unchecked(p_org)
         AND EXISTS (SELECT 1 FROM content_version cv WHERE cv.org_id = c.org_id AND cv.id = c.current_version_id AND cv.status = 'current')))
    AND EXISTS (
      SELECT 1 FROM content_audience a WHERE a.org_id = c.org_id AND a.content_id = c.id AND (
           a.kind = 'org'
        OR (a.kind = 'user'   AND a.principal_id = m.user_id)
        OR (a.kind = 'group'  AND a.principal_id IN (SELECT g.group_id  FROM user_group_membership g WHERE g.org_id = p_org AND g.user_id = m.user_id))
        OR (a.kind = 'stream' AND a.principal_id IN (SELECT s.stream_id FROM user_stream_access     s WHERE s.org_id = p_org AND s.user_id = m.user_id))));
END $$;

-- Viewer rows of a version. For a document: only while the documents flag is on and only for versions that
-- were current at some point (a processing or failed version has no viewers); a retracted document's
-- viewers keep their retraction notice.
CREATE OR REPLACE FUNCTION platform_viewers_of_version(p_org uuid, p_version uuid)
RETURNS TABLE (user_id uuid, title_snapshot text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform STABLE AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_viewers_of_version: org required'; END IF;
  RETURN QUERY SELECT s.user_id, s.title_snapshot FROM user_content_state s
  JOIN org_membership m ON m.org_id = s.org_id AND m.user_id = s.user_id AND m.status = 'active'
  JOIN content c ON c.org_id = s.org_id AND c.id = s.content_id
  WHERE s.org_id = p_org AND s.last_version_id = p_version
    AND (c.kind <> 'document' OR (documents_enabled_unchecked(p_org)
         AND EXISTS (SELECT 1 FROM content_version cv WHERE cv.org_id = s.org_id AND cv.id = p_version AND cv.status IN ('current', 'superseded', 'retracted'))));
END $$;

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
                AND (c.kind <> 'document' OR (documents_enabled_unchecked(p_org)
                     AND EXISTS (SELECT 1 FROM content_version cv WHERE cv.org_id = c.org_id AND cv.id = c.current_version_id AND cv.status = 'current')))
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

-- ---------------------------------------------------------------------------
-- Embedding definer functions. The worker holds no tenant context, so every access is a named function.
-- Vectors are only ever written for hashes some chunk of the org references, and never as a zero vector.
-- ---------------------------------------------------------------------------
-- App role (the only pin read it has): the active pin.
CREATE OR REPLACE FUNCTION platform_embedding_active_pin() RETURNS TABLE (id uuid, model text, dims integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF current_user IS NULL THEN RAISE EXCEPTION 'platform_embedding_active_pin: platform-scope, no tenant data'; END IF;
  RETURN QUERY SELECT p.id, p.model, p.dims FROM platform.embedding_pin p WHERE p.state = 'active';
END $$;

CREATE OR REPLACE FUNCTION platform_embedding_upsert(p_org uuid, p_hash bytea, p_pin uuid, p_vector vector) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_embedding_upsert: org required'; END IF;
  IF p_hash IS NULL OR octet_length(p_hash) <> 32 THEN RAISE EXCEPTION 'platform_embedding_upsert: hash must be 32 bytes'; END IF;
  IF p_vector IS NULL OR vector_norm(p_vector) = 0 THEN RAISE EXCEPTION 'platform_embedding_upsert: zero or missing vector'; END IF;
  -- Vector dimension is enforced by the column; a pin that is not active or shadow is refused by the trigger.
  IF NOT EXISTS (SELECT 1 FROM chunk k WHERE k.org_id = p_org AND k.text_sha256 = p_hash) THEN RETURN false; END IF;
  INSERT INTO embedding (org_id, text_sha256, pin_id, vector) VALUES (p_org, p_hash, p_pin, p_vector)
    ON CONFLICT (org_id, text_sha256, pin_id) DO NOTHING;
  RETURN FOUND;
END $$;

-- Hashes of one version's chunks that have no vector yet under the pin (empty hashes ignored). Nothing is
-- returned while documents are disabled for the org (clip backfill pauses with the flag).
CREATE OR REPLACE FUNCTION platform_embedding_missing_hashes(p_org uuid, p_version uuid, p_pin uuid) RETURNS SETOF bytea
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_embedding_missing_hashes: org required'; END IF;
  IF NOT documents_enabled_unchecked(p_org) THEN RETURN; END IF;
  RETURN QUERY
    SELECT DISTINCT k.text_sha256 FROM chunk k
     WHERE k.org_id = p_org AND k.content_version_id = p_version
       AND octet_length(k.text_sha256) = 32 AND k.text_sha256 <> digest(''::bytea, 'sha256')
       AND NOT EXISTS (SELECT 1 FROM embedding e WHERE e.org_id = k.org_id AND e.text_sha256 = k.text_sha256 AND e.pin_id = p_pin);
END $$;

-- Org-wide missing-vector scan over chunks of current versions (the reconciliation job).
CREATE OR REPLACE FUNCTION platform_embedding_reconcile(p_org uuid, p_pin uuid, p_limit integer) RETURNS SETOF bytea
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_embedding_reconcile: org required'; END IF;
  IF NOT documents_enabled_unchecked(p_org) THEN RETURN; END IF;
  RETURN QUERY
    SELECT DISTINCT k.text_sha256 FROM chunk k JOIN content_version v ON v.org_id = k.org_id AND v.id = k.content_version_id AND v.status = 'current'
     WHERE k.org_id = p_org AND octet_length(k.text_sha256) = 32 AND k.text_sha256 <> digest(''::bytea, 'sha256')
       AND NOT EXISTS (SELECT 1 FROM embedding e WHERE e.org_id = k.org_id AND e.text_sha256 = k.text_sha256 AND e.pin_id = p_pin)
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
END $$;

-- Text of chunks for an embed job (so no text travels in job payloads); current versions only, at most
-- 200 hashes per call, nothing while documents are disabled for the org.
CREATE OR REPLACE FUNCTION platform_embedding_chunk_text(p_org uuid, p_hashes bytea[]) RETURNS TABLE (text_sha256 bytea, text text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_embedding_chunk_text: org required'; END IF;
  IF p_hashes IS NULL OR cardinality(p_hashes) > 200 THEN RAISE EXCEPTION 'platform_embedding_chunk_text: at most 200 hashes per call (org %)', p_org; END IF;
  IF NOT documents_enabled_unchecked(p_org) THEN RETURN; END IF;
  RETURN QUERY
    SELECT DISTINCT ON (k.text_sha256) k.text_sha256, k.text FROM chunk k
      JOIN content_version v ON v.org_id = k.org_id AND v.id = k.content_version_id AND v.status = 'current'
     WHERE k.org_id = p_org AND k.text_sha256 = ANY (p_hashes)
     ORDER BY k.text_sha256, k.id;
END $$;

-- Coverage of one org under a pin: chunk hashes of current versions and how many have a vector. An org with
-- documents disabled counts as (0, 0): nothing is embedded for it, so it cannot hold a switch back.
CREATE OR REPLACE FUNCTION platform_embedding_coverage(p_org uuid, p_pin uuid) RETURNS TABLE (total bigint, covered bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_embedding_coverage: org required'; END IF;
  IF NOT documents_enabled_unchecked(p_org) THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint;
    RETURN;
  END IF;
  RETURN QUERY
    WITH h AS (
      SELECT DISTINCT k.text_sha256 AS th FROM chunk k JOIN content_version v ON v.org_id = k.org_id AND v.id = k.content_version_id AND v.status = 'current'
       WHERE k.org_id = p_org AND octet_length(k.text_sha256) = 32 AND k.text_sha256 <> digest(''::bytea, 'sha256'))
    SELECT count(*)::bigint, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM embedding e WHERE e.org_id = p_org AND e.text_sha256 = h.th AND e.pin_id = p_pin))::bigint FROM h;
END $$;

-- Removes vectors no chunk of the org references. The exclusive advisory lock waits for in-flight
-- platform_document_finish transactions, whose chunks it must see.
CREATE OR REPLACE FUNCTION platform_embedding_gc(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE n integer;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_embedding_gc: org required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('embedding_gc:' || p_org::text));
  DELETE FROM embedding e WHERE e.org_id = p_org
    AND NOT EXISTS (SELECT 1 FROM chunk k WHERE k.org_id = e.org_id AND k.text_sha256 = e.text_sha256);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION platform_embedding_pin_register(p_model text, p_dims integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF p_model IS NULL OR btrim(p_model) = '' OR p_dims IS DISTINCT FROM 1024 THEN
    RAISE EXCEPTION 'platform_embedding_pin_register: platform-scope, model required and dims must be 1024';
  END IF;
  INSERT INTO platform.embedding_pin (id, model, dims, state) VALUES (v_id, left(p_model, 200), p_dims, 'shadow');
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION platform_embedding_pin_ready(p_pin uuid, p_index_valid boolean, p_coverage_complete boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF p_pin IS NULL OR p_index_valid IS NULL OR p_coverage_complete IS NULL THEN
    RAISE EXCEPTION 'platform_embedding_pin_ready: platform-scope, arguments required';
  END IF;
  INSERT INTO platform.embedding_pin_ready (pin_id, index_valid, coverage_complete, checked_at)
    VALUES (p_pin, p_index_valid, p_coverage_complete, now())
    ON CONFLICT (pin_id) DO UPDATE SET index_valid = EXCLUDED.index_valid, coverage_complete = EXCLUDED.coverage_complete, checked_at = now();
END $$;

-- Atomic switch: the target must be a shadow pin whose readiness row (written by the platform-owned job,
-- at most one hour old) records a VALID index and complete coverage (zero chunk hashes without a vector).
-- The old active pin is demoted to shadow before the target is promoted.
CREATE OR REPLACE FUNCTION platform_embedding_pin_switch(p_target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_state text; v_ok boolean;
BEGIN
  IF p_target IS NULL THEN RAISE EXCEPTION 'platform_embedding_pin_switch: platform-scope, target required'; END IF;
  SELECT p.state INTO v_state FROM platform.embedding_pin p WHERE p.id = p_target FOR UPDATE;
  IF v_state IS DISTINCT FROM 'shadow' THEN RAISE EXCEPTION 'platform_embedding_pin_switch: platform-scope, target must be a shadow pin'; END IF;
  SELECT r.index_valid AND r.coverage_complete AND r.checked_at > now() - interval '1 hour' INTO v_ok
    FROM platform.embedding_pin_ready r WHERE r.pin_id = p_target;
  IF v_ok IS NOT TRUE THEN RAISE EXCEPTION 'platform_embedding_pin_switch: platform-scope, target is not ready (index valid, coverage complete, fresh)'; END IF;
  UPDATE platform.embedding_pin SET state = 'shadow' WHERE state = 'active';
  UPDATE platform.embedding_pin SET state = 'active' WHERE id = p_target;
END $$;

-- Retires a shadow pin: removes its vectors (all orgs) and its HNSW index. Not reversible; a retired pin is
-- never switched back to (register a new shadow pin instead).
CREATE OR REPLACE FUNCTION platform_embedding_pin_retire(p_pin uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_state text; n integer;
BEGIN
  IF p_pin IS NULL THEN RAISE EXCEPTION 'platform_embedding_pin_retire: cross-org by design, pin required'; END IF;
  SELECT p.state INTO v_state FROM platform.embedding_pin p WHERE p.id = p_pin FOR UPDATE;
  IF v_state IS DISTINCT FROM 'shadow' THEN RAISE EXCEPTION 'platform_embedding_pin_retire: cross-org by design, only a shadow pin can be retired'; END IF;
  UPDATE platform.embedding_pin SET state = 'retired' WHERE id = p_pin;
  DELETE FROM embedding WHERE pin_id = p_pin;
  GET DIAGNOSTICS n = ROW_COUNT;
  EXECUTE format('DROP INDEX IF EXISTS public.%I', 'embedding_hnsw_' || left(replace(p_pin::text, '-', ''), 8));
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- Grants. Every new function is revoked from PUBLIC first. Platform-only: no grant to the app role.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  chunk_prepare(), embedding_check_pin(), org_documents_flag_changed(),
  documents_enabled_unchecked(uuid), document_mark_failed(uuid, uuid, text),
  platform_documents_enabled(uuid), platform_documents_kill_switch_engaged(), platform_documents_kill_switch_set(boolean),
  platform_documents_flag_init_missing(boolean), platform_documents_flag_set_all(boolean), platform_documents_flag_restore_all(),
  platform_documents_hide(), platform_documents_restore(),
  document_upload_complete(uuid, uuid), platform_document_claim(uuid, uuid), platform_document_step(uuid, uuid, uuid, text, text),
  platform_document_fail(uuid, uuid, text), platform_document_finish(uuid, uuid, uuid, jsonb), platform_content_kind(uuid, uuid),
  platform_embedding_active_pin(), platform_embedding_upsert(uuid, bytea, uuid, vector),
  platform_embedding_missing_hashes(uuid, uuid, uuid), platform_embedding_reconcile(uuid, uuid, integer),
  platform_embedding_chunk_text(uuid, bytea[]), platform_embedding_coverage(uuid, uuid), platform_embedding_gc(uuid),
  platform_embedding_pin_register(text, integer), platform_embedding_pin_ready(uuid, boolean, boolean),
  platform_embedding_pin_switch(uuid), platform_embedding_pin_retire(uuid)
  FROM PUBLIC;

-- Redefined functions keep their existing grants (CREATE OR REPLACE preserves privileges); content_publish,
-- content_retract stay on the app role; platform_version_update, platform_audience_of_content,
-- platform_viewers_of_version, platform_search_reindex stay on the platform role.

-- App role (APP_ALLOWED_FUNCTIONS): the gate, the kill switch read, the active pin and document upload complete.
GRANT EXECUTE ON FUNCTION platform_documents_enabled(uuid), platform_documents_kill_switch_engaged(),
  platform_embedding_active_pin(), document_upload_complete(uuid, uuid) TO ourstream_app;

-- Platform role only.
GRANT EXECUTE ON FUNCTION
  platform_documents_kill_switch_set(boolean), platform_documents_flag_init_missing(boolean), platform_documents_flag_set_all(boolean),
  platform_documents_flag_restore_all(), platform_documents_hide(), platform_documents_restore(),
  platform_document_claim(uuid, uuid), platform_document_step(uuid, uuid, uuid, text, text), platform_document_fail(uuid, uuid, text),
  platform_document_finish(uuid, uuid, uuid, jsonb), platform_content_kind(uuid, uuid),
  platform_embedding_active_pin(), platform_embedding_upsert(uuid, bytea, uuid, vector),
  platform_embedding_missing_hashes(uuid, uuid, uuid), platform_embedding_reconcile(uuid, uuid, integer),
  platform_embedding_chunk_text(uuid, bytea[]), platform_embedding_coverage(uuid, uuid), platform_embedding_gc(uuid),
  platform_embedding_pin_register(text, integer), platform_embedding_pin_ready(uuid, boolean, boolean),
  platform_embedding_pin_switch(uuid), platform_embedding_pin_retire(uuid) TO ourstream_platform;
