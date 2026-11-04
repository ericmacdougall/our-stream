// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { ContentDetail } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';

type Detail = z.output<typeof ContentDetail>;

/**
 * True while work is pending: the current version is still uploading/processing, or (when a
 * specific `untilVersionId` was just uploaded) that version has not become current yet.
 */
export function isProcessing(detail: Detail | null, untilVersionId?: string | null): boolean {
  if (!detail) return false;
  const current = detail.currentVersion;
  if (untilVersionId && current?.id !== untilVersionId) return true;
  const status = current?.status;
  return status === 'uploaded' || status === 'processing';
}

/** Polls GET /v1/content/:id while a version is still being processed (bounded by MAX_POLLS). */
const MAX_POLLS = 600;
const MAX_FAILURES = 10;

export function useContentPolling(
  initial: Detail | null,
  options: { untilVersionId?: string | null; intervalMs?: number } = {},
) {
  const { untilVersionId = null, intervalMs = 2000 } = options;
  const [detail, setDetail] = useState<Detail | null>(initial);
  const [failedFetches, setFailedFetches] = useState(0);
  const [polls, setPolls] = useState(0);

  useEffect(() => {
    setDetail(initial);
  }, [initial]);

  const stalled = failedFetches >= MAX_FAILURES || polls >= MAX_POLLS;
  const processing = isProcessing(detail, untilVersionId);

  useEffect(() => {
    if (!detail || !processing || stalled) return;
    const id = setTimeout(async () => {
      setPolls((n) => n + 1);
      try {
        const { data } = await browserApi().GET('/v1/content/{id}', {
          params: { path: { id: detail.id } },
        });
        if (data) {
          setDetail(data);
          setFailedFetches(0);
        } else setFailedFetches((n) => n + 1);
      } catch {
        setFailedFetches((n) => n + 1);
      }
    }, intervalMs);
    return () => clearTimeout(id);
    // failedFetches is a dependency so a transient error schedules the next attempt.
  }, [detail, processing, stalled, intervalMs, failedFetches]);

  return { detail, setDetail, processing: processing && !stalled, stalled };
}
