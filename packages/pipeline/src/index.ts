// SPDX-License-Identifier: AGPL-3.0-only
export { execTool, ToolError, type ExecOptions, type ExecResult } from './exec.js';
export { probe, interpretProbe, parseFps, ProbeError, type MediaInfo } from './ffprobe.js';
export {
  selectLadder,
  fitWithin,
  isPortrait,
  gopFrames,
  AUDIO_BITRATE,
  type Rendition,
} from './ladder.js';
export { planHls, transcodeHls, type HlsPlan, type HlsOptions } from './hls.js';
export {
  posterTimeMs,
  spritePlan,
  spriteVtt,
  renderPoster,
  renderSprite,
  SPRITE_COLS,
  SPRITE_ROWS,
  SPRITE_TILE_WIDTH,
  type SpritePlan,
} from './thumbs.js';
export {
  segmentsToVtt,
  segmentsToCues,
  splitSegment,
  wrapWords,
  formatVttTime,
  MAX_CUE_MS,
  MAX_LINES,
  MAX_LINE_CHARS,
  type Cue,
} from './captions.js';
export {
  createObjectStore,
  s3ConfigFromEnv,
  contentTypeFor,
  InputTooLargeError,
  CONTENT_TYPES,
  type ObjectStore,
  type S3Config,
} from './s3.js';
export { limitsFromEnv, type PipelineLimits } from './limits.js';
export {
  runMediaPipeline,
  describeFailure,
  redactMessage,
  PipelineError,
  PIPELINE_STEPS,
  type PipelineStep,
  type PipelineInput,
  type PipelineDeps,
  type PipelineResult,
  type MediaAssets,
  type StoredTranscript,
} from './process.js';
