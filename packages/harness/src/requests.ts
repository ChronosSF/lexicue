import type { HarnessConfig } from "./config.js";
import type { CacheTtl, ModelRequest, PromptBlock } from "./model-client.js";
import { PROMPT_VERSION, SYSTEM_PROMPT_V3 } from "./prompts/system-v3.js";
import {
  renderBatchRequest,
  renderGlossaryRequest,
  renderSeasonGlossaryRequest,
  renderSourceDocument,
} from "./prompts/render.js";
import {
  BatchTranslationSchema,
  FileGlossarySchema,
  SeasonGlossarySchema,
  type BatchTranslation,
  type FileGlossary,
  type SeasonGlossary,
} from "./schemas.js";
import type { ProtocolCue, TranslationOptions } from "./types.js";

export { PROMPT_VERSION };

/**
 * Everything a request for one job needs. `sourceDocument` is rendered once and
 * reused, because the bytes of the cached prefix must be identical on every
 * request of the job (spec section 4.8).
 */
export interface RequestContext {
  config: HarnessConfig;
  options: TranslationOptions;
  jobId: string;
  sourceDocument: string;
  /** Overrides the configured model; used for the refusal fallback. */
  model?: string;
}

/** The cache lifetime for a job: one hour on the economy lane (spec 4.5). */
export function cacheTtlFor(context: RequestContext): CacheTtl {
  return context.options.lane === "economy"
    ? context.config.economyCacheTtl
    : context.config.fastCacheTtl;
}

/** Builds the source-document context, rendered once per job. */
export function buildSourceDocument(cues: readonly ProtocolCue[]): string {
  return renderSourceDocument(cues);
}

/**
 * The glossary pass: the system prompt and the entire source file with a cache
 * breakpoint after the file, then the request (spec section 4.4).
 */
export function buildGlossaryRequest(
  context: RequestContext,
  seasonGlossary: SeasonGlossary | null,
): ModelRequest<FileGlossary> {
  return {
    ...base(context),
    outputSchema: FileGlossarySchema,
    purpose: "glossary",
    user: [
      cachedBlock(context.sourceDocument, cacheTtlFor(context)),
      { text: renderGlossaryRequest(context.options, seasonGlossary) },
    ],
  };
}

/**
 * The season glossary: one call over a sample of every file in the upload
 * (spec section 4.4). Its prefix is not shared with any file's job, so it takes
 * no cache breakpoint on the sample.
 */
export function buildSeasonGlossaryRequest(
  context: RequestContext,
  sample: string,
): ModelRequest<SeasonGlossary> {
  return {
    ...base(context),
    outputSchema: SeasonGlossarySchema,
    purpose: "season-glossary",
    user: [{ text: sample }, { text: renderSeasonGlossaryRequest(context.options) }],
  };
}

/** One batch of cues, repeating the identical cached prefix (spec section 4.4). */
export function buildBatchRequest(
  context: RequestContext,
  batch: {
    glossary: FileGlossary;
    cues: readonly ProtocolCue[];
    findings?: readonly string[];
  },
): ModelRequest<BatchTranslation> {
  return {
    ...base(context),
    outputSchema: BatchTranslationSchema,
    purpose: "batch",
    user: [
      cachedBlock(context.sourceDocument, cacheTtlFor(context)),
      {
        text: renderBatchRequest({
          glossary: batch.glossary,
          options: context.options,
          cues: batch.cues,
          ...(batch.findings === undefined ? {} : { findings: batch.findings }),
        }),
      },
    ],
  };
}

function base(context: RequestContext): {
  model: string;
  maxTokens: number;
  effort: HarnessConfig["effort"];
  jobId: string;
  system: PromptBlock[];
} {
  return {
    model: context.model ?? context.config.model,
    maxTokens: context.config.maxTokens,
    effort: context.config.effort,
    jobId: context.jobId,
    system: [cachedBlock(SYSTEM_PROMPT_V3, cacheTtlFor(context))],
  };
}

function cachedBlock(text: string, ttl: CacheTtl): PromptBlock {
  return { text, cacheControl: { ttl } };
}
