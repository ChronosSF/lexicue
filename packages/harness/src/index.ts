export { DEFAULT_HARNESS_CONFIG, resolveConfig, type HarnessConfig } from "./config.js";

export {
  BatchNeverEndedError,
  HarnessConfigError,
  LaneNotSupportedError,
  ModelTransportError,
} from "./errors.js";

export {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CAPABILITIES,
  canCachePrefix,
  capabilitiesFor,
  type ModelCapabilities,
} from "./model-capabilities.js";

export {
  addUsage,
  emptyUsage,
  supportsBatches,
  type BatchModelClient,
  type BatchOutcome,
  type BatchRequestItem,
  type BatchResultItem,
  type BatchStatus,
  type CacheTtl,
  type Effort,
  type ModelRequest,
  type ModelResponse,
  type ModelStopReason,
  type ModelUsage,
  type PromptBlock,
  type RequestPurpose,
  type TokenCountRequest,
  type TranslationModelClient,
} from "./model-client.js";

export {
  BatchTranslationSchema,
  CardPatternSchema,
  CharacterSchema,
  FileGlossarySchema,
  RegisterSchema,
  RepeatedLineRenderingSchema,
  SeasonGlossarySchema,
  TermSchema,
  emptyGlossary,
  type BatchTranslation,
  type CardPattern,
  type Character,
  type FileGlossary,
  type Register,
  type RepeatedLineRendering,
  type SeasonGlossary,
  type Term,
} from "./schemas.js";

export {
  REPEAT_LIMIT,
  REPEAT_MIN_CHARS,
  REPEAT_MIN_WORDS,
  findRepeatedLines,
  findRepeatedLinesAcross,
  repeatKey,
  type RepeatOptions,
  type RepeatedLine,
} from "./repeats.js";

export {
  TARGET_LANGUAGES,
  findTargetLanguage,
  looksUntranslated,
  type Script,
  type TargetLanguage,
} from "./languages.js";

export {
  MAX_CONTEXT_NOTE_LENGTH,
  toProtocolCue,
  type Formality,
  type LineHandling,
  type ProtocolCue,
  type TranslationJob,
  type TranslationOptions,
} from "./types.js";

export { PROMPT_VERSION, SYSTEM_PROMPT_V4 } from "./prompts/system-v4.js";
export {
  LINE_MARKER,
  renderBatchRequest,
  renderCueLine,
  renderGlossary,
  renderGlossaryRequest,
  renderJobHeader,
  renderSeasonGlossaryRequest,
  renderSourceDocument,
  splitTranslatedLines,
} from "./prompts/render.js";

export {
  FakeTranslationModelClient,
  cachedPrefix,
  estimateTokens,
  parseBatchRequest,
  repeatedLinesIn,
  type FakeClientOptions,
} from "./clients/fake.js";
export { AnthropicTranslationClient, type AnthropicClientOptions } from "./clients/anthropic.js";
export {
  FaultInjectingModelClient,
  applyFault,
  type Fault,
  type FaultInjectingOptions,
} from "./clients/fault.js";

export { mapWithConcurrency, realWait, type Wait } from "./concurrency.js";
export { withTransportRetry } from "./transport.js";
export {
  buildBatchRequest,
  buildGlossaryRequest,
  buildSeasonGlossaryRequest,
  buildSourceDocument,
  cacheTtlFor,
  type RequestContext,
} from "./requests.js";
export {
  findContradictions,
  mergeGlossaries,
  runGlossaryPass,
  type GlossaryPassResult,
} from "./glossary.js";
export {
  buildSeasonSample,
  runSeasonGlossaryPass,
  type SeasonGlossaryResult,
  type SeasonSample,
} from "./season.js";
export {
  CUSTOM_ID_PATTERN,
  collectEconomyBatch,
  parseCustomId,
  planBatches,
  runFastLaneBatches,
  runOneBatch,
  submitEconomyBatch,
  type BatchPlanEntry,
  type CollectOptions,
  type EconomyEntry,
  type RawBatchResult,
} from "./batches.js";

export { matchLineCount, reflowLines, rewrapWithSourceTags } from "./reflow.js";
export { validateBatch, type BatchValidation, type CueFinding } from "./validate.js";
export { reassembleDocument } from "./reassemble.js";
export {
  DEFAULT_MODEL_PRICE,
  MODEL_PRICES,
  costBreakdown,
  formatUsd,
  modelCostUsd,
  priceFor,
  type CostBreakdown,
  type ModelPrice,
} from "./cost.js";
export {
  buildFileReport,
  type FileReport,
  type LineLengthFinding,
  type ReadingSpeedFinding,
  type UntranslatedCue,
  type UploadReport,
} from "./report.js";
export {
  describeCaching,
  translateFile,
  type FileProgress,
  type ProgressCallback,
  type TranslateFileInput,
  type TranslatedFile,
} from "./translate-file.js";
export {
  translateUpload,
  type TranslateUploadInput,
  type TranslatedUpload,
} from "./translate-upload.js";
