-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0009 (M1b, ADR-0013): keyword search index. Titles and descriptions get a generated
-- tsvector on content; transcripts become `chunk` rows (M0 table) of at most 20 s or 400 characters,
-- cut at segment boundaries, built in the transaction that makes a version current.
--
-- Rollback note (ADR-0012): drop the two triggers, the functions search_index_version,
-- content_version_index_insert/update, platform_search_reindex, platform_search_prune, then the
-- content.search_tsv column and its index; chunk rows may be deleted or left (the search query joins
-- content_version.status = 'current', so stale rows are never served).
--
-- M2 note: embeddings will live on these rows; a reindex replaces them, so M2 must either re-embed on
-- reindex or compute embeddings on a stable text hash (ADR-0013 consequences).

ALTER TABLE content ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || description)) STORED;
CREATE INDEX content_search_tsv_idx ON content USING gin (search_tsv);

CREATE OR REPLACE FUNCTION search_index_version(p_org uuid, p_version uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_content uuid; v_transcript jsonb; v_lang text; seg jsonb; s_start integer; s_end integer; s_text text;
        w_start integer; w_end integer; w_text text := ''; v_n integer := 0;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'search_index_version: org required'; END IF;
  SELECT content_id, transcript INTO v_content, v_transcript FROM content_version WHERE org_id = p_org AND id = p_version;
  IF v_content IS NULL THEN RETURN 0; END IF;
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
      INSERT INTO chunk (org_id, content_version_id, content_id, locator, text, lang)
        VALUES (p_org, p_version, v_content, jsonb_build_object('kind', 'transcript', 'start_ms', w_start, 'end_ms', w_end), w_text, v_lang);
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
    INSERT INTO chunk (org_id, content_version_id, content_id, locator, text, lang)
      VALUES (p_org, p_version, v_content, jsonb_build_object('kind', 'transcript', 'start_ms', w_start, 'end_ms', w_end), w_text, v_lang);
    v_n := v_n + 1;
  END IF;
  RETURN v_n;
END $$;

-- Index in the same transaction that makes a version current. Two triggers so the UPDATE form can
-- compare OLD and NEW: asset-only updates of a current version do not rebuild the rows (review F9).
CREATE OR REPLACE FUNCTION content_version_index_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'content_version_index_trigger: org required'; END IF;
  PERFORM search_index_version(NEW.org_id, NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER content_version_index_insert AFTER INSERT ON content_version FOR EACH ROW
  WHEN (NEW.status = 'current') EXECUTE FUNCTION content_version_index_trigger();
CREATE TRIGGER content_version_index_update AFTER UPDATE OF status, transcript ON content_version FOR EACH ROW
  WHEN (NEW.status = 'current' AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.transcript IS DISTINCT FROM NEW.transcript))
  EXECUTE FUNCTION content_version_index_trigger();

-- Worker maintenance: rebuild one org (after a window-size change) and drop rows of non-current versions.
CREATE OR REPLACE FUNCTION platform_search_reindex(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v uuid; v_n integer := 0;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_search_reindex: org required'; END IF;
  FOR v IN SELECT id FROM content_version WHERE org_id = p_org AND status = 'current' LOOP
    v_n := v_n + search_index_version(p_org, v);
  END LOOP;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION platform_search_prune(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
DECLARE v_n integer;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'platform_search_prune: org required'; END IF;
  DELETE FROM chunk k USING content_version v
    WHERE k.org_id = p_org AND v.org_id = k.org_id AND v.id = k.content_version_id AND v.status <> 'current';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE EXECUTE ON FUNCTION search_index_version(uuid, uuid), content_version_index_trigger(), platform_search_reindex(uuid), platform_search_prune(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_search_reindex(uuid), platform_search_prune(uuid) TO ourstream_platform;
