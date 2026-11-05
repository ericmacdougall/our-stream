// SPDX-License-Identifier: AGPL-3.0-only
export type {
  AsrProvider,
  Capability,
  EmbedErrorCode,
  EmbedInput,
  EmbedProvider,
  OrgModelPolicy,
  PolicyRefusalReason,
  ProviderDescriptor,
  RetentionClass,
  TrainingUse,
  Transcript,
  TranscriptSegment,
  TranscribeInput,
} from './types.js';
export { DEFAULT_EMBED_MODEL, EMBED_DIMS, EmbedError, ProviderPolicyError } from './types.js';
export { checkPolicy, selectProvider, type PolicyDecision } from './policy.js';
export { createFakeAsr, fakeAsrDescriptor, fakeSegments, wavDurationMs } from './asr/fake.js';
export {
  createWhisperHttpAsr,
  whisperHttpDescriptor,
  type WhisperHttpOptions,
} from './asr/whisper-http.js';
export { createAsrProviderFromEnv, type AsrProviderName } from './asr/from-env.js';
export {
  createFakeEmbed,
  fakeEmbedDescriptor,
  fakeVector,
  type FakeEmbedOptions,
} from './embed/fake.js';
export {
  QUERY_INSTRUCTION,
  createQwenHttpEmbed,
  qwenHttpDescriptor,
  type QwenHttpOptions,
} from './embed/qwen-http.js';
export { createEmbedProviderFromEnv, type EmbedProviderName } from './embed/from-env.js';
