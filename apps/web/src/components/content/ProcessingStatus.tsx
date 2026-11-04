// SPDX-License-Identifier: AGPL-3.0-only
import type { z } from 'zod';
import type { VersionSummary } from '@our-stream/contracts';
import { t, type MessageId } from '@/lib/i18n';

type Version = z.output<typeof VersionSummary>;

const STATUS_LABEL: Record<Version['status'], MessageId> = {
  uploaded: 'content.status.uploaded',
  processing: 'content.status.processing',
  current: 'content.status.current',
  superseded: 'content.status.superseded',
  retracted: 'content.status.retracted',
  failed: 'content.status.failed',
};

export function ProcessingStatus({
  version,
  pending = false,
}: {
  version: Version | null;
  pending?: boolean;
}) {
  if (!version) {
    return pending ? (
      <p role="status" aria-live="polite" data-testid="processing-status" data-status="processing">
        <strong>{t('content.status.processing')}</strong>
      </p>
    ) : (
      <p className="muted">{t('content.status.noVersion')}</p>
    );
  }
  const busy = version.status === 'uploaded' || version.status === 'processing';
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="processing-status"
      data-status={version.status}
    >
      <strong>{t(STATUS_LABEL[version.status])}</strong>
      {busy && version.processingStep
        ? ` · ${t('content.status.step', { step: version.processingStep })}`
        : ''}
      {version.status === 'failed' && version.processingError
        ? ` · ${version.processingError}`
        : ''}
      {version.status === 'current' && version.durationMs !== null
        ? ` · ${t('content.duration', { seconds: Math.round(version.durationMs / 1000) })}`
        : ''}
      {version.status === 'current'
        ? ` · ${version.hasCaptions ? t('content.captionsReady') : t('content.captionsMissing')}`
        : ''}
    </p>
  );
}
