import type { Lane, TranslationOptions } from "@lexicue/shared";
import { applyRefund } from "@lexicue/shared";
import {
  DEFAULT_HARNESS_CONFIG,
  resolveConfig,
  translateUpload,
  type HarnessConfig,
  type TargetLanguage,
  type TranslationJob,
  type TranslationModelClient,
  type TranslationOptions as HarnessOptions,
} from "@lexicue/harness";
import { encodeSubtitleDocument } from "@lexicue/subtitles/encoding";
import type { SubtitleDocument } from "@lexicue/subtitles";
import type { DevBatch, DevJob, DevStore } from "./state.js";
import { FILE_RETENTION_MS } from "./state.js";

/**
 * The worker of spec section 7.5, as a function call instead of a Lambda behind
 * a queue. It runs the real harness over the real files with whatever model
 * client it was given, reports progress into the job rows after every batch,
 * and writes each finished file to disk as it lands.
 *
 * One behaviour is coarser than section 2.3 asks for. `translateUpload` drives
 * a whole upload — the season glossary and then every file in order — and
 * raises rather than isolating a single bad file, so a failure here fails the
 * files that had not finished and refunds each of them individually. The
 * per-file isolation of section 2.3 needs the queue and the one-message-per-file
 * split of section 7.5, which is Phase 2's worker, not this.
 */

export interface UploadWork {
  batch: DevBatch;
  /** The files to translate, and their parsed documents, in the same order. */
  jobs: DevJob[];
  documents: SubtitleDocument[];
  /** Every job of the batch, including any already failed, for settling. */
  allJobs: DevJob[];
  target: TargetLanguage;
  options: TranslationOptions;
}

export interface TranslationRunner {
  run: (work: UploadWork) => Promise<void>;
}

export interface RunnerOptions {
  store: DevStore;
  client: TranslationModelClient;
  config?: Partial<HarnessConfig>;
  now?: () => number;
}

/** Cues per model request, which is what a progress bar counts (spec 4.4). */
export function batchesFor(cueCount: number, batchSize: number): number {
  return Math.max(1, Math.ceil(cueCount / batchSize));
}

/** The output file name of spec section 2.1: `original-name.de.srt`. */
export function outputFileName(fileName: string, languageCode: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName}.${languageCode}`;
  return `${fileName.slice(0, dot)}.${languageCode}${fileName.slice(dot)}`;
}

/** Running time is where the last cue ends (spec section 2.1). */
export function runningTimeMs(document: SubtitleDocument): number {
  return document.cues.reduce((longest, cue) => Math.max(longest, cue.endMs), 0);
}

export function harnessOptions(
  options: TranslationOptions,
  target: TargetLanguage,
  lane: Lane,
): HarnessOptions {
  return {
    target,
    lane,
    formality: options.formality,
    contextNote: options.contextNote,
    lineHandling: options.lineHandling,
    translateLyrics: options.translateLyrics,
  };
}

export function createRunner(options: RunnerOptions): TranslationRunner {
  const { store, client } = options;
  const config = resolveConfig(options.config ?? {});
  const clock = options.now ?? ((): number => Date.now());

  return {
    async run(work: UploadWork): Promise<void> {
      const { batch, jobs, documents } = work;
      const byJobId = new Map(jobs.map((job) => [job.jobId, job]));

      if (jobs.length === 0) {
        settleBatch(store, batch, work.allJobs, clock());
        return;
      }

      batch.status = "running";
      for (const job of jobs) job.status = "queued";
      store.save();

      const translationJobs: TranslationJob[] = jobs.map((job, index) => ({
        jobId: job.jobId,
        fileName: job.fileName,
        // Every job has a document; the caller parsed them together.
        document: documents[index] ?? emptyDocumentOf(job),
      }));

      let finishedCount = 0;
      try {
        const upload = await translateUpload({
          client,
          config,
          options: harnessOptions(work.options, work.target, batch.lane),
          jobs: translationJobs,
          onProgress: (progress) => {
            const job = byJobId.get(progress.jobId);
            if (job === undefined) return;
            job.status = job.status === "queued" ? "running" : job.status;
            job.batchesTotal = progress.batchesTotal;
            job.batchesDone = progress.batchesDone;
            store.save();
          },
          onFile: (file) => {
            // Files come back in the order they were given, which is the order
            // `translateUpload` translates them in.
            const job = jobs[finishedCount];
            finishedCount += 1;
            if (job === undefined) return;
            store.writeFileBytes(
              store.outputPath(job.jobId),
              encodeSubtitleDocument(file.document, { bom: job.outputBom }),
            );
            job.hasOutput = true;
            job.report = file.report;
            job.sourceLanguage = file.glossary.sourceLanguage;
            job.status = "done";
            job.batchesDone = job.batchesTotal;
            job.finishedAt = clock();
            store.save();
          },
        });

        const summary = upload.report.seasonGlossary;
        const glossary = upload.seasonGlossary;
        batch.seasonGlossary =
          summary === null || glossary === null
            ? null
            : {
                applied: summary.applied,
                characters: glossary.characters,
                terms: glossary.terms,
                styleNotes: glossary.styleNotes,
                register: glossary.register,
                sourceLanguage: glossary.sourceLanguage,
                sampledFiles: summary.sampledFiles,
                droppedFiles: summary.droppedFiles,
              };
      } catch (error) {
        failRemaining(store, batch, jobs, messageFor(error), clock());
      }

      settleBatch(store, batch, work.allJobs, clock());
      store.save();
    },
  };
}

/**
 * A user-safe sentence, never a stack trace and never an error code (spec
 * section 2.3). The real reason goes to the server's own log.
 */
function messageFor(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[dev-api] translation failed: ${detail}\n`);
  return "This file could not be translated, so it was refunded to your balance. The server log has the reason.";
}

/** Every file that had not finished fails and is refunded (spec section 2.3). */
function failRemaining(
  store: DevStore,
  batch: DevBatch,
  jobs: readonly DevJob[],
  message: string,
  now: number,
): void {
  const state = store.current();
  for (const job of jobs) {
    if (job.status === "done" || job.status === "failed") continue;
    job.status = "failed";
    job.error = message;
    job.refundedCents = job.priceCents;
    job.finishedAt = now;
    batch.refundedCents += job.priceCents;
    applyRefund(state, {
      amountCents: job.priceCents,
      freeCents: job.freeChargedCents,
      ref: job.jobId,
      description: `Refund for ${job.fileName}`,
      now,
    });
  }
}

function settleBatch(store: DevStore, batch: DevBatch, jobs: readonly DevJob[], now: number): void {
  const failed = jobs.filter((job) => job.status === "failed").length;
  batch.status = failed === 0 ? "done" : failed === jobs.length ? "failed" : "partial";
  batch.finishedAt = Math.max(now, ...jobs.map((job) => job.finishedAt ?? now));
  batch.filesExpireAt = batch.finishedAt + FILE_RETENTION_MS;
  store.save();
}

function emptyDocumentOf(job: DevJob): SubtitleDocument {
  return {
    format: job.format,
    encoding: job.encoding,
    bom: false,
    eol: "\n",
    header: "",
    cues: [],
    trailingNewline: true,
    dialogueChars: 0,
    warnings: [],
  };
}

export { DEFAULT_HARNESS_CONFIG };
