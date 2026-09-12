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

/**
 * What the Message Batches API accepts as a `custom_id`, quoted from the 400 it
 * answers with when a request breaks it. Spec section 4.5 asks for
 * `{jobId}:{batchIndex}`, and a colon is not in this set: the first real
 * economy-lane submission on 12 September 2026 was rejected before a single
 * batch ran. The separator is an underscore for that reason.
 */
export const CUSTOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** One batch of cues, with the custom id the Message Batches API keys it by. */
export interface BatchPlanEntry {
  index: number;
  /** `{jobId}_{batchIndex}`; see {@link CUSTOM_ID_PATTERN}. */
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
      customId: `${jobId}_${index.toString()}`,
      cues: cues.slice(start, start + batchSize),
    });
  }
  return entries;
}

/**
 * Parses `{jobId}_{batchIndex}` back into its parts. The last underscore is the
 * separator, so a job id may contain underscores of its own.
 */
export function parseCustomId(customId: string): { jobId: string; batchIndex: number } | null {
  const separator = customId.lastIndexOf("_");
  if (separator === -1) return null;
  const batchIndex = Number(customId.slice(separator + 1));
  if (!Number.isInteger(batchIndex) || batchIndex < 0) return null;
  return { jobId: customId.slice(0, separator), batchIndex };
}

/**
 * Fails a Message Batch before it is submitted if any `custom_id` would be
 * rejected or would collide.
 *
 * The API validates `custom_id` and answers the whole submission with a 400
 * naming one offending request, which on the economy lane means every file's
 * glossary pass has already been paid for when the batch is refused. Checking
 * here costs nothing and turns a paid failure into a local one whose message
 * says which id and why.
 */
function assertCustomIdsAreSubmittable(requests: readonly BatchRequestItem[]): void {
  const seen = new Set<string>();
  for (const item of requests) {
    if (!CUSTOM_ID_PATTERN.test(item.customId)) {
      throw new RangeError(
        `The Message Batches API will reject the custom_id "${item.customId}": it must match ${CUSTOM_ID_PATTERN.source}. Job ids reach the custom id unchanged, so this one has to be made of letters, digits, underscores and hyphens.`,
      );
    }
    if (seen.has(item.customId)) {
      throw new RangeError(
        `Two requests in one Message Batch share the custom_id "${item.customId}", so their results could not be told apart.`,
      );
    }
    seen.add(item.customId);
  }
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

/**
 * Runs a file's batches on the fast lane: the first one alone, then the rest up
 * to `concurrency` at a time.
 *
 * The first batch runs alone because it is the one that writes the cached
 * prefix. Nothing else can have warmed it — spec section 4.4 expects the
 * glossary pass to, but a request's structured-output schema is part of its
 * cache key and the glossary's schema is not the batch schema — so a cold
 * fan-out is a race that nobody wins. Measured against Sonnet 5 on 11 September
 * 2026: twelve concurrent requests over a cold prefix each wrote their own copy
 * of it and none read, and the same twelve run afterwards all read and wrote
 * nothing.
 *
 * On the film of spec section 5.4 that race costs about $0.74 of cache writes
 * against the $0.12 the section budgets, which is most of the file's margin.
 * Letting one batch land first buys it back for one batch of latency. The
 * economy lane needs none of this: its requests go into one Message Batch and
 * its cache hits are best-effort either way (spec section 4.5).
 */
export async function runFastLaneBatches(
  client: TranslationModelClient,
  context: RequestContext,
  plan: readonly BatchPlanEntry[],
  glossary: FileGlossary,
  /** Called as each batch answers, for the progress of spec section 7.5. */
  onBatchDone?: () => void,
): Promise<RawBatchResult[]> {
  const [first, ...rest] = plan;
  if (first === undefined) return [];
  const warmed = await runOneBatch(client, context, first, glossary);
  onBatchDone?.();
  if (rest.length === 0) return [warmed];
  const remainder = await mapWithConcurrency(rest, context.config.concurrency, async (entry) => {
    const result = await runOneBatch(client, context, entry, glossary);
    onBatchDone?.();
    return result;
  });
  return [warmed, ...remainder];
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
 * each with a `custom_id` of `{jobId}_{batchIndex}`.
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
  assertCustomIdsAreSubmittable(requests);
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
