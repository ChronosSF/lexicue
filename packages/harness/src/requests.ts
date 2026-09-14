import type { HarnessConfig } from "./config.js";
import type { CacheTtl, ModelRequest, PromptBlock } from "./model-client.js";
import { PROMPT_VERSION, SYSTEM_PROMPT_V4 } from "./prompts/system-v4.js";
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
import type { RepeatedLine } from "./repeats.js";
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
 * The glossary pass: the system prompt and the entire source file, then the
 * request (spec section 4.4).
 *
 * The source file takes no cache breakpoint here, which is the one place this
 * harness departs from section 4.4. The section has this call warm the prefix
 * every batch then reads, but a request's structured-output schema renders
 * ahead of the system prompt, the way a tool list does, and is part of the
 * cache key — and this call's schema is the glossary's, not the batch schema.
 * Measured against Sonnet 5 on 11 September 2026, a batch with byte-identical
 * prefix bytes wrote the prefix again rather than reading what this call wrote.
 * An entry nothing can read is not worth a write premium of 1.25x, or 2x at the
 * economy lane's one-hour TTL, so the file is sent as plain input and the first
 * batch writes the entry the batches share.
 *
 * The system prompt keeps its breakpoint: that prefix really is shared, by
 * every glossary pass of every file.
 */
export function buildGlossaryRequest(
  context: RequestContext,
  seasonGlossary: SeasonGlossary | null,
  repeatedLines: readonly RepeatedLine[] = [],
): ModelRequest<FileGlossary> {
  return {
    ...base(context),
    outputSchema: FileGlossarySchema,
    purpose: "glossary",
    user: [
      { text: context.sourceDocument },
      { text: renderGlossaryRequest(context.options, seasonGlossary, repeatedLines) },
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
  repeatedLines: readonly RepeatedLine[] = [],
): ModelRequest<SeasonGlossary> {
  return {
    ...base(context),
    outputSchema: SeasonGlossarySchema,
    purpose: "season-glossary",
    user: [{ text: sample }, { text: renderSeasonGlossaryRequest(context.options, repeatedLines) }],
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
    system: [cachedBlock(SYSTEM_PROMPT_V4, cacheTtlFor(context))],
  };
}

function cachedBlock(text: string, ttl: CacheTtl): PromptBlock {
  return { text, cacheControl: { ttl } };
}
