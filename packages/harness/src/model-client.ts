import type { z } from "zod";

/**
 * Effort levels the Messages API accepts (`output_config.effort`), cheapest
 * first. The list is the type's own source rather than a copy of it, so a
 * command line that validates a level against it cannot drift from what the
 * harness will actually send. Whether a given model accepts the field at all is
 * the capability table's business (`acceptsEffort`), not this list's.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

/** Whether a string is one of the levels {@link EFFORT_LEVELS} lists. */
export function isEffort(value: string): value is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Cache breakpoint lifetimes the API accepts. */
export type CacheTtl = "5m" | "1h";

/**
 * One text block of a request. A block with `cacheControl` set carries a
 * `cache_control` breakpoint, so everything up to and including it is the
 * cacheable prefix.
 */
export interface PromptBlock {
  text: string;
  cacheControl?: { ttl: CacheTtl };
}

/**
 * What the request is for; carried through to logs, reports and fault
 * injection. "judge" is the eval runner's scoring call, which uses the same
 * client interface but never runs inside the product.
 */
export type RequestPurpose = "season-glossary" | "glossary" | "batch" | "judge";

/**
 * A single model call, in the harness's own terms. Everything the concrete
 * client needs is here, and nothing about the Anthropic SDK leaks out: the fake
 * client, the fault-injecting client and the real client all implement this.
 */
export interface ModelRequest<T> {
  model: string;
  maxTokens: number;
  effort: Effort;
  /** Frozen system prompt blocks; the last one usually carries a breakpoint. */
  system: PromptBlock[];
  /** User blocks: the whole source document first, then the request-specific text. */
  user: PromptBlock[];
  /** The structured-output schema the API is asked to enforce. */
  outputSchema: z.ZodType<T>;
  purpose: RequestPurpose;
  /** Identifies the job this request belongs to; used by caching diagnostics. */
  jobId: string;
}

/** Why the model stopped, reduced to the cases the harness acts on. */
export type ModelStopReason = "end_turn" | "max_tokens" | "refusal" | "other";

/** Token usage, summed onto the job for the cost metric (spec section 4.8). */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
}

/** An empty usage record, the identity for {@link addUsage}. */
export function emptyUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
  };
}

/** Adds `next` into `total` in place and returns it. */
export function addUsage(total: ModelUsage, next: ModelUsage): ModelUsage {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.cacheCreationInputTokens += next.cacheCreationInputTokens;
  total.cacheReadInputTokens += next.cacheReadInputTokens;
  total.cacheCreation5mInputTokens += next.cacheCreation5mInputTokens;
  total.cacheCreation1hInputTokens += next.cacheCreation1hInputTokens;
  return total;
}

export interface ModelResponse<T> {
  /** null when the API could not produce output matching the schema. */
  parsed: T | null;
  stopReason: ModelStopReason;
  /** Populated only when `stopReason` is "refusal". */
  refusalCategory: string | null;
  usage: ModelUsage;
  /** The model that actually served the request. */
  model: string;
}

/** The input to the ingestion gate's token count (spec section 4.9). */
export interface TokenCountRequest {
  model: string;
  system: PromptBlock[];
  user: PromptBlock[];
}

/**
 * The small interface the harness talks to (spec section 5.6). The concrete
 * client is chosen by configuration, which is what makes the same harness run
 * against the real API, a fake and a fault injector without changing.
 */
export interface TranslationModelClient {
  readonly name: string;
  /**
   * True when the client already retries 429 and 5xx responses itself, as the
   * Anthropic SDK does. The harness then does not add a second layer.
   */
  readonly retriesTransportErrors: boolean;
  complete<T>(request: ModelRequest<T>): Promise<ModelResponse<T>>;
  countTokens(request: TokenCountRequest): Promise<number>;
}

/**
 * One request inside a Message Batch, keyed by `{jobId}_{batchIndex}`. The
 * separator is an underscore, not the colon in spec section 4.5, because a
 * `custom_id` must match `^[a-zA-Z0-9_-]{1,64}$`; see `CUSTOM_ID_PATTERN` in
 * batches.ts.
 */
export interface BatchRequestItem {
  customId: string;
  request: ModelRequest<unknown>;
}

/** Processing status of a Message Batch. */
export interface BatchStatus {
  id: string;
  processingStatus: "in_progress" | "canceling" | "ended";
  endedAt: string | null;
  counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
}

export type BatchOutcome = "succeeded" | "errored" | "canceled" | "expired";

/** One line of a Message Batch's results; they arrive in any order. */
export interface BatchResultItem {
  customId: string;
  outcome: BatchOutcome;
  /** Present only when `outcome` is "succeeded". */
  response: ModelResponse<unknown> | null;
  /** Present only when `outcome` is "errored". */
  error: string | null;
}

/** A client that can also run the economy lane (spec section 4.5). */
export interface BatchModelClient extends TranslationModelClient {
  submitBatch(requests: BatchRequestItem[]): Promise<string>;
  getBatch(batchId: string): Promise<BatchStatus>;
  streamBatchResults(batchId: string): AsyncIterable<BatchResultItem>;
}

/** True when the client can run the economy lane. */
export function supportsBatches(client: TranslationModelClient): client is BatchModelClient {
  const candidate = client as Partial<BatchModelClient>;
  return (
    typeof candidate.submitBatch === "function" &&
    typeof candidate.getBatch === "function" &&
    typeof candidate.streamBatchResults === "function"
  );
}
