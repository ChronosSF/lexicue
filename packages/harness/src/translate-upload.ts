import {
  planBatches,
  collectEconomyBatch,
  submitEconomyBatch,
  type BatchPlanEntry,
  type CollectOptions,
} from "./batches.js";
import type { HarnessConfig } from "./config.js";
import { LaneNotSupportedError } from "./errors.js";
import { runGlossaryPass } from "./glossary.js";
import {
  addUsage,
  emptyUsage,
  supportsBatches,
  type ModelUsage,
  type TranslationModelClient,
} from "./model-client.js";
import { findRepeatedLines } from "./repeats.js";
import { buildSourceDocument, type RequestContext } from "./requests.js";
import type { UploadReport } from "./report.js";
import { runSeasonGlossaryPass, type SeasonSample } from "./season.js";
import type { FileGlossary, SeasonGlossary } from "./schemas.js";
import { translateFile, type ProgressCallback, type TranslatedFile } from "./translate-file.js";
import { toProtocolCue, type TranslationJob, type TranslationOptions } from "./types.js";

export interface TranslateUploadInput {
  client: TranslationModelClient;
  config: HarnessConfig;
  options: TranslationOptions;
  jobs: readonly TranslationJob[];
  now?: () => number;
  /** Passed through to the economy lane's poller; tests use it to avoid sleeping. */
  collect?: CollectOptions;
  /** Called as each file finishes, for progress output. */
  onFile?: (file: TranslatedFile) => void;
  /** Called as each batch of each file answers (spec section 7.5). */
  onProgress?: ProgressCallback;
}

export interface TranslatedUpload {
  files: TranslatedFile[];
  /** The shared style sheet, after every file's extensions (spec section 4.4). */
  seasonGlossary: SeasonGlossary | null;
  seasonSample: SeasonSample | null;
  usage: ModelUsage;
  report: UploadReport;
}

/**
 * Translates a whole upload (spec section 4.4). For more than one file, a
 * season glossary is produced first from a sample of every file, and then each
 * file's own glossary pass extends it: a character introduced in episode two
 * reaches episode three, while nothing a file infers can contradict what the
 * season fixed.
 *
 * Files are processed in order rather than in parallel, because that ordering
 * is what makes the extension of the glossary meaningful.
 */
export async function translateUpload(input: TranslateUploadInput): Promise<TranslatedUpload> {
  const { client, options, jobs } = input;
  const usage = emptyUsage();

  let seasonGlossary: SeasonGlossary | null = null;
  let seasonSample: SeasonSample | null = null;

  if (jobs.length > 1) {
    const pass = await runSeasonGlossaryPass(client, uploadContext(input), jobs);
    addUsage(usage, pass.usage);
    seasonGlossary = pass.glossary;
    seasonSample = pass.sample;
  }

  const files =
    options.lane === "economy"
      ? await runEconomyLane(input, seasonGlossary, usage)
      : await runFastLane(input, seasonGlossary, usage);

  const running = files.at(-1)?.glossary ?? seasonGlossary;

  return {
    files,
    seasonGlossary: running === null ? null : (running satisfies FileGlossary),
    seasonSample,
    usage,
    report: {
      files: files.map((file) => file.report),
      totalCues: files.reduce((sum, file) => sum + file.report.totalCues, 0),
      totalDialogueChars: files.reduce((sum, file) => sum + file.report.dialogueChars, 0),
      totalPriceCents: files.reduce((sum, file) => sum + file.report.priceCents, 0),
      totalModelCostUsd: files.reduce((sum, file) => sum + file.report.modelCostUsd, 0),
      seasonGlossary:
        seasonGlossary === null
          ? null
          : {
              applied: true,
              characters: running?.characters.length ?? 0,
              terms: running?.terms.length ?? 0,
              styleNotes: running?.styleNotes.length ?? 0,
              sampledFiles: seasonSample?.includedFiles ?? [],
              droppedFiles: seasonSample?.droppedFiles ?? [],
            },
    },
  };
}

async function runFastLane(
  input: TranslateUploadInput,
  seasonGlossary: SeasonGlossary | null,
  usage: ModelUsage,
): Promise<TranslatedFile[]> {
  const files: TranslatedFile[] = [];
  let running = seasonGlossary;
  for (const job of input.jobs) {
    const file = await translateFile({
      client: input.client,
      config: input.config,
      options: input.options,
      job,
      seasonGlossary: running,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    });
    addUsage(usage, file.usage);
    // The file's glossary is the season's plus whatever this episode added, so
    // carrying it forward is what makes a later episode see the addition.
    if (seasonGlossary !== null) running = file.glossary;
    input.onFile?.(file);
    files.push(file);
  }
  return files;
}

/**
 * The economy lane of spec section 4.5: every file's glossary pass runs
 * interactively first, then all of their batch requests go into a single
 * Message Batch, and the results are collected and validated exactly as the
 * fast lane's are.
 */
async function runEconomyLane(
  input: TranslateUploadInput,
  seasonGlossary: SeasonGlossary | null,
  usage: ModelUsage,
): Promise<TranslatedFile[]> {
  const { client, config, options } = input;
  if (!supportsBatches(client)) throw new LaneNotSupportedError(client.name);

  const prepared: {
    job: TranslationJob;
    context: RequestContext;
    glossary: FileGlossary;
    plan: BatchPlanEntry[];
  }[] = [];
  let running = seasonGlossary;

  for (const job of input.jobs) {
    const cues = job.document.cues.map(toProtocolCue);
    const context: RequestContext = {
      config,
      options,
      jobId: job.jobId,
      sourceDocument: buildSourceDocument(cues),
    };
    // The economy lane runs the glossary pass up front, so it is here rather
    // than in translateFile that the file's repeated lines must be found.
    const pass = await runGlossaryPass(client, context, running, findRepeatedLines(cues));
    addUsage(usage, pass.usage);
    if (seasonGlossary !== null) running = pass.glossary;
    prepared.push({
      job,
      context,
      glossary: pass.glossary,
      plan: planBatches(job.jobId, cues, config.batchSize),
    });
  }

  const { batchId } = await submitEconomyBatch(
    client,
    prepared.map((entry) => ({
      context: entry.context,
      glossary: entry.glossary,
      plan: entry.plan,
    })),
  );

  const byCustomId = new Map<string, BatchPlanEntry>();
  for (const entry of prepared) {
    for (const batch of entry.plan) byCustomId.set(batch.customId, batch);
  }
  const collected = await collectEconomyBatch(
    client,
    batchId,
    byCustomId,
    config,
    input.collect ?? {},
  );

  const files: TranslatedFile[] = [];
  for (const entry of prepared) {
    const file = await translateFile({
      client,
      config,
      options,
      job: entry.job,
      seasonGlossary,
      glossary: entry.glossary,
      collected,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    });
    addUsage(usage, file.usage);
    input.onFile?.(file);
    files.push(file);
  }
  return files;
}

function uploadContext(input: TranslateUploadInput): RequestContext {
  return {
    config: input.config,
    options: input.options,
    jobId: "upload",
    sourceDocument: "",
  };
}
