import type { SubtitleDocument } from "@lexicue/subtitles";
import { serialiseAndVerify } from "@lexicue/subtitles";
import {
  planBatches,
  runFastLaneBatches,
  runOneBatch,
  type BatchPlanEntry,
  type RawBatchResult,
} from "./batches.js";
import type { HarnessConfig } from "./config.js";
import { runGlossaryPass } from "./glossary.js";
import {
  addUsage,
  emptyUsage,
  type ModelUsage,
  type TranslationModelClient,
} from "./model-client.js";
import { buildSourceDocument, PROMPT_VERSION, type RequestContext } from "./requests.js";
import { reassembleDocument } from "./reassemble.js";
import { buildFileReport, type FileReport, type UntranslatedCue } from "./report.js";
import type { FileGlossary, SeasonGlossary } from "./schemas.js";
import {
  toProtocolCue,
  type ProtocolCue,
  type TranslationJob,
  type TranslationOptions,
} from "./types.js";
import { validateBatch } from "./validate.js";

export interface TranslateFileInput {
  client: TranslationModelClient;
  config: HarnessConfig;
  options: TranslationOptions;
  job: TranslationJob;
  /** The shared style sheet for a multi-file upload, or null. */
  seasonGlossary?: SeasonGlossary | null;
  /** A glossary already produced; the economy lane runs its pass up front. */
  glossary?: FileGlossary;
  /** Message Batch results, keyed by custom id, for the economy lane. */
  collected?: ReadonlyMap<string, RawBatchResult>;
  /** Injectable clock, so wall times in tests are deterministic. */
  now?: () => number;
}

export interface TranslatedFile {
  document: SubtitleDocument;
  /** The serialised, verified output text, ready to be written. */
  text: string;
  glossary: FileGlossary;
  report: FileReport;
  usage: ModelUsage;
}

/**
 * The whole of spec sections 4.4 and 4.6 for one file: glossary pass, batches,
 * validation, retries, reassembly from the raw timing lines, and the final
 * re-parse that proves the output matches the input structurally.
 *
 * A cue that cannot be translated after its retries keeps its source text and
 * is listed in the report. The file still completes; only a structural
 * mismatch, which is always a bug, fails it.
 */
export async function translateFile(input: TranslateFileInput): Promise<TranslatedFile> {
  const { client, config, options, job } = input;
  const now = input.now ?? Date.now;
  const started = now();

  const cues = job.document.cues.map(toProtocolCue);
  const context: RequestContext = {
    config,
    options,
    jobId: job.jobId,
    sourceDocument: buildSourceDocument(cues),
  };

  const usage = emptyUsage();
  const warnings: string[] = [...job.document.warnings];
  const repairs: string[] = [];
  const state = { fallbackModelUsed: false };

  let glossary = input.glossary;
  if (glossary === undefined) {
    const pass = await runGlossaryPass(client, context, input.seasonGlossary ?? null);
    addUsage(usage, pass.usage);
    glossary = pass.glossary;
    if (pass.degraded) {
      warnings.push(
        "The glossary pass produced nothing usable; the file was translated without shared names or register.",
      );
    }
  }

  const plan = planBatches(job.jobId, cues, config.batchSize);
  const collected = input.collected;
  const initial =
    collected === undefined
      ? await runFastLaneBatches(client, context, plan, glossary)
      : plan.map((entry) => collectedFor(collected, entry));

  const translations = new Map<number, string[]>();
  const untranslated: UntranslatedCue[] = [];
  const cueById = new Map(cues.map((cue) => [cue.id, cue]));
  let batchCount = 0;

  for (const [index, entry] of plan.entries()) {
    const raw = initial[index];
    if (raw === undefined) continue;
    const resolved = await resolveBatch(
      client,
      context,
      entry,
      glossary,
      raw,
      usage,
      warnings,
      state,
    );
    batchCount += resolved.length;
    for (const piece of resolved) {
      await settleBatch({
        client,
        context,
        glossary,
        entry: piece.entry,
        result: piece.result,
        cueById,
        translations,
        untranslated,
        repairs,
        warnings,
        usage,
        job,
      });
    }
  }

  if (collected === undefined) {
    const cacheWarning = detectCacheProblem(initial);
    if (cacheWarning !== null) warnings.push(cacheWarning);
  }

  const outputDocument = reassembleDocument(job.document, translations);
  const { text } = serialiseAndVerify(job.document, outputDocument);

  const report = buildFileReport({
    file: job.fileName,
    source: job.document,
    output: outputDocument,
    untranslated,
    glossaryEntriesApplied: glossary.characters.length + glossary.terms.length,
    seasonGlossaryApplied: (input.seasonGlossary ?? null) !== null,
    repairs,
    warnings,
    usage,
    wallTimeMs: now() - started,
    batches: batchCount,
    model: config.model,
    fallbackModelUsed: state.fallbackModelUsed,
    promptVersion: PROMPT_VERSION,
    lane: options.lane,
    target: options.target,
    config,
  });

  return { document: outputDocument, text, glossary, report, usage };
}

interface ResolvedPiece {
  entry: BatchPlanEntry;
  result: RawBatchResult;
}

/**
 * Turns one batch answer into pieces that can be validated: a `max_tokens` stop
 * is re-run as two half batches, and a `refusal` is retried once on the
 * fallback model (spec section 4.6).
 */
async function resolveBatch(
  client: TranslationModelClient,
  context: RequestContext,
  entry: BatchPlanEntry,
  glossary: FileGlossary,
  result: RawBatchResult,
  usage: ModelUsage,
  warnings: string[],
  state: { fallbackModelUsed: boolean },
): Promise<ResolvedPiece[]> {
  addUsage(usage, result.usage);

  if (result.stopReason === "max_tokens" && entry.cues.length > 1) {
    warnings.push(
      `Batch ${entry.customId} hit the output limit and was re-run as two half batches.`,
    );
    const middle = Math.ceil(entry.cues.length / 2);
    const halves: BatchPlanEntry[] = [
      { index: entry.index, customId: `${entry.customId}a`, cues: entry.cues.slice(0, middle) },
      { index: entry.index, customId: `${entry.customId}b`, cues: entry.cues.slice(middle) },
    ];
    const pieces: ResolvedPiece[] = [];
    for (const half of halves) {
      const halfResult = await runOneBatch(client, context, half, glossary);
      pieces.push(
        ...(await resolveBatch(
          client,
          context,
          half,
          glossary,
          halfResult,
          usage,
          warnings,
          state,
        )),
      );
    }
    return pieces;
  }

  if (result.stopReason === "refusal") {
    warnings.push(
      `Batch ${entry.customId} was refused${result.refusalCategory === null ? "" : ` (${result.refusalCategory})`}; it was retried on the fallback model ${context.config.fallbackModel}.`,
    );
    state.fallbackModelUsed = true;
    const retried = await runOneBatch(
      client,
      { ...context, model: context.config.fallbackModel },
      entry,
      glossary,
    );
    addUsage(usage, retried.usage);
    if (retried.stopReason === "refusal") {
      warnings.push(
        `Batch ${entry.customId} was refused by the fallback model too; its cues are left in the source language.`,
      );
    }
    return [{ entry, result: retried }];
  }

  return [{ entry, result }];
}

interface SettleInput {
  client: TranslationModelClient;
  context: RequestContext;
  glossary: FileGlossary;
  entry: BatchPlanEntry;
  result: RawBatchResult;
  cueById: ReadonlyMap<number, ProtocolCue>;
  translations: Map<number, string[]>;
  untranslated: UntranslatedCue[];
  repairs: string[];
  warnings: string[];
  usage: ModelUsage;
  job: TranslationJob;
}

/**
 * Validates one batch and retries only the cues that failed, each time quoting
 * the validator's finding back (spec section 4.6). After two retries a cue
 * keeps its source text and goes into the report.
 */
async function settleBatch(input: SettleInput): Promise<void> {
  const { client, context, glossary, entry, result } = input;
  const config = context.config;
  const validation = validateBatch({
    sourceCues: entry.cues,
    answers: result.answers,
    target: context.options.target,
    config,
    lineHandling: context.options.lineHandling,
  });

  for (const [id, lines] of validation.accepted) input.translations.set(id, lines);
  input.repairs.push(...validation.repairs);
  input.warnings.push(...validation.warnings);

  let pending = failuresFor(entry.cues, validation.failures, result.error);

  for (let attempt = 1; attempt <= config.maxCueRetries && pending.length > 0; attempt += 1) {
    const retryCues = pending
      .map((failure) => input.cueById.get(failure.id))
      .filter((cue): cue is ProtocolCue => cue !== undefined);
    if (retryCues.length === 0) break;
    const retryEntry: BatchPlanEntry = {
      index: entry.index,
      customId: `${entry.customId}r${attempt.toString()}`,
      cues: retryCues,
    };
    const retried = await runOneBatch(
      client,
      context,
      retryEntry,
      glossary,
      pending.map((failure) => failure.finding),
    );
    addUsage(input.usage, retried.usage);
    const retryValidation = validateBatch({
      sourceCues: retryCues,
      answers: retried.answers,
      target: context.options.target,
      config,
      lineHandling: context.options.lineHandling,
    });
    for (const [id, lines] of retryValidation.accepted) input.translations.set(id, lines);
    input.repairs.push(...retryValidation.repairs);
    pending = failuresFor(retryCues, retryValidation.failures, retried.error);
  }

  for (const failure of pending) {
    const sourceCue = input.job.document.cues.find((cue) => cue.id === failure.id);
    input.untranslated.push({
      id: failure.id,
      index: sourceCue?.rawIndexLine ?? null,
      timing: sourceCue?.rawTimingLine ?? "",
      reason: failure.finding,
    });
  }
}

/**
 * When a batch failed outright — a transport error, an errored Message Batch
 * entry — every cue in it is unanswered, and the reason to record is that
 * failure rather than the validator's "this id was missing".
 */
function failuresFor(
  cues: readonly ProtocolCue[],
  failures: readonly { id: number; finding: string }[],
  error: string | null,
): { id: number; finding: string }[] {
  if (error === null) return [...failures];
  return cues.map((cue) => ({
    id: cue.id,
    finding: `cue ${cue.id.toString()} was not answered: ${error}`,
  }));
}

function collectedFor(
  collected: ReadonlyMap<string, RawBatchResult>,
  entry: BatchPlanEntry,
): RawBatchResult {
  const found = collected.get(entry.customId);
  if (found !== undefined) return found;
  return {
    index: entry.index,
    customId: entry.customId,
    requestedIds: entry.cues.map((cue) => cue.id),
    answers: [],
    stopReason: "other",
    refusalCategory: null,
    usage: emptyUsage(),
    error: `The Message Batch returned no result for ${entry.customId}.`,
  };
}

/**
 * The warning of spec section 4.8: a fast-lane batch whose
 * `cache_read_input_tokens` is zero after the glossary pass means the cached
 * prefix was silently changed, which is always a bug in the request builder.
 */
function detectCacheProblem(results: readonly RawBatchResult[]): string | null {
  const answered = results.filter(
    (result) => result.error === null && result.usage.outputTokens > 0,
  );
  if (answered.length === 0) return null;
  const cold = answered.filter((result) => result.usage.cacheReadInputTokens === 0);
  if (cold.length === 0) return null;
  return `${cold.length.toString()} of ${answered.length.toString()} batches read nothing from the prompt cache; the cached prefix is probably not byte-identical across requests.`;
}
