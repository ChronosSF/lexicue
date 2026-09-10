import type { HarnessConfig } from "./config.js";
import { mapWithConcurrency, realWait, type Wait } from "./concurrency.js";
import { BatchNeverEndedError } from "./errors.js";
import type {
  BatchModelClient,
  BatchRequestItem,
  ModelResponse,
  ModelStopReason,
  ModelUsage,
  TranslationModelClient,
} from "./model-client.js";
import { emptyUsage } from "./model-client.js";
import { buildBatchRequest, type RequestContext } from "./requests.js";
import { BatchTranslationSchema, type FileGlossary } from "./schemas.js";
import { withTransportRetry } from "./transport.js";
import type { ProtocolCue } from "./types.js";

/** One batch of cues, with the custom id the Message Batches API keys it by. */
export interface BatchPlanEntry {
  index: number;
  /** `{jobId}:{batchIndex}` (spec section 4.5). */
  customId: string;
  cues: ProtocolCue[];
}

/** Groups a file's cues into batches of the configured size (spec section 4.4). */
export function planBatches(
  jobId: string,
  cues: readonly ProtocolCue[],
  batchSize: number,
): BatchPlanEntry[] {
  if (batchSize < 1) throw new RangeError("batch size must be at least 1");
  const entries: BatchPlanEntry[] = [];
  for (let start = 0; start < cues.length; start += batchSize) {
    const index = entries.length;
    entries.push({
      index,
      customId: `${jobId}:${index.toString()}`,
      cues: cues.slice(start, start + batchSize),
    });
  }
  return entries;
}

/** Parses `{jobId}:{batchIndex}` back into its parts. */
export function parseCustomId(customId: string): { jobId: string; batchIndex: number } | null {
  const separator = customId.lastIndexOf(":");
  if (separator === -1) return null;
  const batchIndex = Number(customId.slice(separator + 1));
  if (!Number.isInteger(batchIndex) || batchIndex < 0) return null;
  return { jobId: customId.slice(0, separator), batchIndex };
}

/** One batch's answer, exactly as the model gave it: not yet validated. */
export interface RawBatchResult {
  index: number;
  customId: string;
  /** The ids that were requested. */
  requestedIds: number[];
  /** The answers, keyed by id, in the order they arrived. */
  answers: { i: number; t: string }[];
  stopReason: ModelStopReason;
  refusalCategory: string | null;
  usage: ModelUsage;
  /** Set when the batch failed outright, rather than answering badly. */
  error: string | null;
}

/** Runs a file's batches on the fast lane, up to `concurrency` at a time. */
export async function runFastLaneBatches(
  client: TranslationModelClient,
  context: RequestContext,
  plan: readonly BatchPlanEntry[],
  glossary: FileGlossary,
): Promise<RawBatchResult[]> {
  return mapWithConcurrency(plan, context.config.concurrency, async (entry) =>
    runOneBatch(client, context, entry, glossary),
  );
}

/** Runs a single batch and reduces the answer to a {@link RawBatchResult}. */
export async function runOneBatch(
  client: TranslationModelClient,
  context: RequestContext,
  entry: BatchPlanEntry,
  glossary: FileGlossary,
  findings?: readonly string[],
): Promise<RawBatchResult> {
  const request = buildBatchRequest(context, {
    glossary,
    cues: entry.cues,
    ...(findings === undefined ? {} : { findings }),
  });
  try {
    const response = await withTransportRetry(client, context.config, () =>
      client.complete(request),
    );
    return toRawResult(entry, response);
  } catch (error) {
    return {
      index: entry.index,
      customId: entry.customId,
      requestedIds: entry.cues.map((cue) => cue.id),
      answers: [],
      stopReason: "other",
      refusalCategory: null,
      usage: emptyUsage(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** What goes into one Message Batch: every file's batches after its glossary pass. */
export interface EconomyEntry {
  context: RequestContext;
  glossary: FileGlossary;
  plan: readonly BatchPlanEntry[];
}

/**
 * Submits every file's batch requests as one Message Batch (spec section 4.5),
 * each with a `custom_id` of `{jobId}:{batchIndex}`.
 */
export async function submitEconomyBatch(
  client: BatchModelClient,
  entries: readonly EconomyEntry[],
): Promise<{ batchId: string; requests: BatchRequestItem[] }> {
  const requests: BatchRequestItem[] = [];
  for (const entry of entries) {
    for (const batch of entry.plan) {
      requests.push({
        customId: batch.customId,
        request: buildBatchRequest(entry.context, {
          glossary: entry.glossary,
          cues: batch.cues,
        }),
      });
    }
  }
  const batchId = await client.submitBatch(requests);
  return { batchId, requests };
}

export interface CollectOptions {
  wait?: Wait;
  /** Overrides the configured maximum wait; tests use a small number. */
  maxWaitMs?: number;
  /** Overrides the configured poll interval. */
  pollIntervalMs?: number;
}

/**
 * Waits for a Message Batch to end and collects its results, keyed by
 * `custom_id` because results arrive in any order (spec section 4.5). A batch
 * that has not ended inside the waiting window raises
 * {@link BatchNeverEndedError}, which the caller resolves by re-running the
 * affected files on the fast lane and refunding them.
 */
export async function collectEconomyBatch(
  client: BatchModelClient,
  batchId: string,
  plan: ReadonlyMap<string, BatchPlanEntry>,
  config: HarnessConfig,
  options: CollectOptions = {},
): Promise<Map<string, RawBatchResult>> {
  const wait = options.wait ?? realWait;
  const pollIntervalMs = options.pollIntervalMs ?? config.economyPollIntervalMs;
  const maxWaitMs = options.maxWaitMs ?? config.economyMaxWaitMs;

  let waited = 0;
  for (;;) {
    const status = await client.getBatch(batchId);
    if (status.processingStatus === "ended") break;
    if (waited >= maxWaitMs) throw new BatchNeverEndedError(batchId, waited);
    await wait(pollIntervalMs);
    waited += pollIntervalMs;
  }

  const collected = new Map<string, RawBatchResult>();
  for await (const item of client.streamBatchResults(batchId)) {
    const entry = plan.get(item.customId);
    if (entry === undefined) continue; // A result for a job we are not collecting.
    if (item.outcome !== "succeeded" || item.response === null) {
      collected.set(item.customId, {
        index: entry.index,
        customId: item.customId,
        requestedIds: entry.cues.map((cue) => cue.id),
        answers: [],
        stopReason: "other",
        refusalCategory: null,
        usage: emptyUsage(),
        error: item.error ?? `The Message Batch entry ${item.customId} came back ${item.outcome}.`,
      });
      continue;
    }
    collected.set(item.customId, toRawResult(entry, item.response));
  }

  // An entry the batch never mentioned is as much a failure as an errored one.
  for (const [customId, entry] of plan) {
    if (collected.has(customId)) continue;
    collected.set(customId, {
      index: entry.index,
      customId,
      requestedIds: entry.cues.map((cue) => cue.id),
      answers: [],
      stopReason: "other",
      refusalCategory: null,
      usage: emptyUsage(),
      error: `The Message Batch returned no result for ${customId}.`,
    });
  }

  return collected;
}

function toRawResult(entry: BatchPlanEntry, response: ModelResponse<unknown>): RawBatchResult {
  const parsed = BatchTranslationSchema.safeParse(response.parsed);
  return {
    index: entry.index,
    customId: entry.customId,
    requestedIds: entry.cues.map((cue) => cue.id),
    answers: parsed.success ? parsed.data.cues : [],
    stopReason: response.stopReason,
    refusalCategory: response.refusalCategory,
    usage: response.usage,
    error:
      parsed.success || response.stopReason !== "end_turn"
        ? null
        : "The model's answer did not match the batch schema.",
  };
}
