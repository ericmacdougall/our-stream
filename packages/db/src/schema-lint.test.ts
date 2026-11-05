// SPDX-License-Identifier: AGPL-3.0-only
// Unit assertions over the schema-lint allow-lists (M2a): platform-only functions must never be on the
// app allow-list, and the three groups are disjoint.
import { describe, expect, it } from 'vitest';
import {
  APP_ALLOWED_FUNCTIONS,
  INTERNAL_ONLY_FUNCTIONS,
  PLATFORM_ONLY_FUNCTIONS,
} from './schema-lint.js';

describe('schema lint allow-lists', () => {
  it('lists a non-trivial number of platform-only functions (not vacuous)', () => {
    expect(PLATFORM_ONLY_FUNCTIONS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(PLATFORM_ONLY_FUNCTIONS).size).toBe(PLATFORM_ONLY_FUNCTIONS.length);
  });

  it('no platform-only or internal function is on the app allow-list', () => {
    const leaked = [...PLATFORM_ONLY_FUNCTIONS, ...INTERNAL_ONLY_FUNCTIONS].filter((f) =>
      APP_ALLOWED_FUNCTIONS.has(f),
    );
    expect(leaked).toEqual([]);
  });

  it('every function the spec names as app-facing is on the allow-list', () => {
    for (const f of [
      'platform_embedding_active_pin',
      'platform_documents_enabled',
      'platform_documents_kill_switch_engaged',
      'document_upload_complete',
    ])
      expect(APP_ALLOWED_FUNCTIONS.has(f), f).toBe(true);
  });

  it('every worker-side embedding and document function named by the spec is platform-only', () => {
    for (const f of [
      'platform_embedding_upsert',
      'platform_embedding_missing_hashes',
      'platform_embedding_gc',
      'platform_embedding_reconcile',
      'platform_embedding_chunk_text',
      'platform_embedding_pin_register',
      'platform_embedding_pin_ready',
      'platform_embedding_pin_switch',
      'platform_embedding_pin_retire',
      'platform_document_finish',
      'platform_document_step',
      'platform_document_claim',
      'platform_document_fail',
      'platform_documents_flag_set_all',
      'platform_documents_hide',
      'platform_documents_restore',
      'platform_content_kind',
    ])
      expect(PLATFORM_ONLY_FUNCTIONS.includes(f), f).toBe(true);
  });
});
