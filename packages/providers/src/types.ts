// SPDX-License-Identifier: AGPL-3.0-only
// Provider abstraction (ADR-0008). M1a ships the `asr` capability only; the descriptor and policy
// shapes are shared by every later capability so routing stays one code path.

export type Capability = 'asr' | 'embed' | 'chat' | 'rerank' | 'translate' | 'tts' | 'video';

export type RetentionClass =
  'self_hosted' | 'zdr_contractual' | 'default_retention' | 'trains_by_default';

export type TrainingUse = 'never' | 'opt_out' | 'default_on';

/** Static metadata shipped with each adapter, reviewed against vendor documentation on `verifiedOn`. */
export interface ProviderDescriptor {
  id: string;
  vendor: string;
  capability: Capability;
  models: { id: string; languages?: string[]; deprecatedOn?: string }[];
  /** ISO region codes the data may be processed in; `['local']` for in-cluster services. */
  regions: string[];
  retentionClass: RetentionClass;
  trainingUse: TrainingUse;
  requiresContract: boolean;
  residencyNotes: string;
  sourceUrl: string;
  /** ISO date (YYYY-MM-DD) the descriptor was last checked against the vendor's terms. */
  verifiedOn: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  /** BCP-47 primary language subtag as detected or requested (for example `en`). */
  language: string;
  segments: TranscriptSegment[];
}

export interface TranscribeInput {
  /** Local path to a 16 kHz mono PCM WAV file (the pipeline normalises every upload to this). */
  path: string;
  /** Requested language; omitted means detect. */
  language?: string;
  /** Known duration of the file; adapters that cannot read it from the file may require it. */
  durationMs?: number;
}

export interface AsrProvider {
  readonly descriptor: ProviderDescriptor;
  transcribe(input: TranscribeInput): Promise<Transcript>;
}

/** Org model policy (ADR-0008 §3). `allowTrainingUse` is fixed to false and not configurable. */
export interface OrgModelPolicy {
  selfHostOnly: boolean;
  requireZdr: boolean;
  allowedVendors?: string[];
  allowedRegions?: string[];
}

export class ProviderPolicyError extends Error {
  constructor(
    message: string,
    public readonly reason: PolicyRefusalReason,
    public readonly providerId: string,
  ) {
    super(message);
    this.name = 'ProviderPolicyError';
  }
}

export type PolicyRefusalReason =
  | 'not_self_hosted'
  | 'retention_not_zdr'
  | 'training_use'
  | 'vendor_not_allowed'
  | 'region_not_allowed'
  | 'wrong_capability';
