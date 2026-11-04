// SPDX-License-Identifier: AGPL-3.0-only
export type {
  AsrProvider,
  Capability,
  OrgModelPolicy,
  PolicyRefusalReason,
  ProviderDescriptor,
  RetentionClass,
  TrainingUse,
  Transcript,
  TranscriptSegment,
  TranscribeInput,
} from './types.js';
export { ProviderPolicyError } from './types.js';
export { checkPolicy, selectProvider, type PolicyDecision } from './policy.js';
export { createFakeAsr, fakeAsrDescriptor, fakeSegments, wavDurationMs } from './asr/fake.js';
export {
  createWhisperHttpAsr,
  whisperHttpDescriptor,
  type WhisperHttpOptions,
} from './asr/whisper-http.js';
export { createAsrProviderFromEnv, type AsrProviderName } from './asr/from-env.js';
