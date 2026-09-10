export { DEFAULT_HARNESS_CONFIG, resolveConfig, type HarnessConfig } from "./config.js";

export {
  BatchNeverEndedError,
  HarnessConfigError,
  LaneNotSupportedError,
  ModelTransportError,
} from "./errors.js";

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
  CharacterSchema,
  FileGlossarySchema,
  RegisterSchema,
  SeasonGlossarySchema,
  TermSchema,
  emptyGlossary,
  type BatchTranslation,
  type Character,
  type FileGlossary,
  type Register,
  type SeasonGlossary,
  type Term,
} from "./schemas.js";

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

export { PROMPT_VERSION, SYSTEM_PROMPT_V3 } from "./prompts/system-v3.js";
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
  type FakeClientOptions,
} from "./clients/fake.js";
export {
  FaultInjectingModelClient,
  applyFault,
  type Fault,
  type FaultInjectingOptions,
} from "./clients/fault.js";
