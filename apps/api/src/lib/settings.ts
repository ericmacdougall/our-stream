// SPDX-License-Identifier: AGPL-3.0-only
// Org settings live in org.settings (jsonb). The API reads the keys it owns with defaults and writes
// them back by merging per top-level key, so keys owned by other components (for example
// notify.include_title_after_access_loss, read by the worker) survive every PATCH (review F15).
import type { TenantClient } from '@our-stream/db';
import type { z } from 'zod';
import type { OrgSettings } from '@our-stream/contracts';

export type Settings = z.infer<typeof OrgSettings>;

export const DEFAULT_SETTINGS: Settings = {
  privacyMode: 'identified_for_required_only', // decision Q1; aggregate until required content exists (M4)
  commentsEnabled: true, // decision Q7
  engagementRetentionDays: 395, // decision Q12: 13 months
  commentScanPolicy: 'off', // ADR-0009
};

const PRIVACY = new Set(['aggregate_only', 'named', 'identified_for_required_only']);
const SCAN = new Set(['off', 'warn', 'block']);

export function settingsFromRaw(raw: unknown): Settings {
  const r = (raw ?? {}) as {
    privacy?: { viewers?: unknown };
    comments?: { enabled?: unknown };
    engagement?: { retention_days?: unknown };
    scan?: { comments?: unknown };
  };
  const privacy = r.privacy?.viewers;
  const scan = r.scan?.comments;
  const days = Number(r.engagement?.retention_days);
  return {
    privacyMode:
      typeof privacy === 'string' && PRIVACY.has(privacy)
        ? (privacy as Settings['privacyMode'])
        : DEFAULT_SETTINGS.privacyMode,
    commentsEnabled: r.comments?.enabled !== false && r.comments?.enabled !== 'false',
    engagementRetentionDays:
      Number.isInteger(days) && days >= 30 && days <= 3650
        ? days
        : DEFAULT_SETTINGS.engagementRetentionDays,
    commentScanPolicy:
      typeof scan === 'string' && SCAN.has(scan)
        ? (scan as Settings['commentScanPolicy'])
        : DEFAULT_SETTINGS.commentScanPolicy,
  };
}

/** The jsonb fragment to merge for the keys this API owns. */
export function settingsToRaw(s: Settings): Record<string, unknown> {
  return {
    privacy: { viewers: s.privacyMode },
    comments: { enabled: s.commentsEnabled },
    engagement: { retention_days: s.engagementRetentionDays },
    scan: { comments: s.commentScanPolicy },
  };
}

export async function readOrgSettings(client: TenantClient, lock = false): Promise<Settings> {
  const r = await client.query<{ settings: unknown }>(
    `SELECT settings FROM org WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [client.tenant.orgId],
  );
  return settingsFromRaw(r.rows[0]?.settings);
}

export async function writeOrgSettings(client: TenantClient, next: Settings): Promise<void> {
  await client.query(`UPDATE org SET settings = settings || $2::jsonb WHERE id = $1`, [
    client.tenant.orgId,
    JSON.stringify(settingsToRaw(next)),
  ]);
}

/** `viewers` lists appear only under `named`; `identified_for_required_only` is aggregate until M4. */
export function showsNamedViewers(s: Settings): boolean {
  return s.privacyMode === 'named';
}
