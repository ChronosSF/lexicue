import {
  resolveConfig,
  translateUpload,
  type TranslationJob,
  type TranslationModelClient,
} from "@lexicue/harness";
import { encodeSubtitleDocument } from "@lexicue/subtitles/encoding";
import type { SubtitleDocument } from "@lexicue/subtitles";
import { outputKey, type AccountData, type BatchRecord, type JobRecord } from "./records.js";
import { failJobs, harnessOptions, settleBatch, type PlannedBatch } from "./lifecycle.js";
import { requireTargetLanguage } from "./intake.js";
import type { CoreEnvironment, FileStore } from "./stores.js";
import type { ApiService } from "./service.js";

/**
 * The worker of specification section 7.5, as a function.
 *
 * In Phase 2 this is what the SQS-fed Lambda calls, and in development it is
 * what `pnpm dev` calls in the background of the same process. It runs the real
 * harness, writes progress into the job rows after every batch so the bar
 * advances for a real reason, stores each finished file as it lands, and
 * settles the batch at the end.
 *
 * One behaviour is coarser than section 2.3 asks for, and knowingly so.
 * `translateUpload` drives a whole upload — the season glossary, then every
 * file in order — and raises rather than isolating one bad file, so a failure
 * here fails every file of the upload that had not finished and refunds each of
 * them separately. The ledger stays exact; the blast radius is an upload rather
 * than a file. Per-file isolation needs the queue and the one-message-per-file
 * split of section 7.5, which is the deployed worker's shape, not this one's.
 */

export interface UploadOutcome {
  done: number;
  failed: number;
}

export interface RunUploadInput {
  work: PlannedBatch;
  client: TranslationModelClient;
  service: ApiService;
  files: FileStore;
  environment: CoreEnvironment;
  batchSize?: number;
  /** Where the real reason for a failure goes; the user never sees it. */
  log?: (line: string) => void;
}

export async function runUpload(input: RunUploadInput): Promise<UploadOutcome> {
  const { work, client, service, files, environment } = input;
  const config = resolveConfig(input.batchSize === undefined ? {} : { batchSize: input.batchSize });
  const data = await service.load();
  const batch = find(data.batches, work.batch.batchId, (row) => row.batchId);
  const jobs = work.jobs.flatMap((planned) => {
    const job = data.jobs.find((row) => row.jobId === planned.jobId);
    return job === undefined ? [] : [job];
  });

  if (batch === null || jobs.length === 0) {
    if (batch !== null) {
      settleBatch(batch, jobsOf(data, batch), environment.now());
      await service.commit({ putBatches: [batch] });
    }
    return { done: 0, failed: 0 };
  }

  batch.status = "running";
  for (const job of jobs) job.status = "queued";
  // `translateUpload` works through the files in order, and the first file's
  // glossary pass starts before any batch is planned. Leaving it "queued" until
  // the first batch answers showed nothing happening for the ten seconds that
  // pass takes.
  const first = jobs[0];
  if (first !== undefined) first.status = "running";
  await service.commit({ putBatches: [batch], putJobs: jobs });

  const byJobId = new Map(jobs.map((job) => [job.jobId, job]));
  const translationJobs: TranslationJob[] = jobs.map((job, index) => ({
    jobId: job.jobId,
    fileName: job.fileName,
    document: work.documents[index] ?? emptyDocumentOf(job),
  }));

  // The harness's callbacks are synchronous and the stores are not, so every
  // write they ask for is queued onto one chain. Serialising them keeps the
  // order the harness reported things in, and awaiting the chain before the
  // batch settles is what stops a job being `done` with `hasOutput` set before
  // its bytes have actually landed.
  let pending: Promise<void> = Promise.resolve();
  const queue = (write: () => Promise<void>): void => {
    pending = pending.then(write);
  };

  let finishedCount = 0;
  try {
    const upload = await translateUpload({
      client,
      config,
      options: harnessOptions(
        batch.options,
        requireTargetLanguage(batch.targetLanguage),
        batch.lane,
      ),
      jobs: translationJobs,
      onProgress: (progress) => {
        const job = byJobId.get(progress.jobId);
        if (job === undefined) return;
        job.status = job.status === "queued" ? "running" : job.status;
        job.batchesTotal = progress.batchesTotal;
        job.batchesDone = progress.batchesDone;
        queue(() => service.commit({ putJobs: [job] }));
      },
      onFile: (file) => {
        // Files come back in the order they were given, which is the order
        // `translateUpload` translates them in.
        const job = jobs[finishedCount];
        finishedCount += 1;
        if (job === undefined) return;
        job.report = file.report;
        job.sourceLanguage = file.glossary.sourceLanguage;
        job.status = "done";
        job.batchesDone = job.batchesTotal;
        job.finishedAt = environment.now();
        const next = jobs[finishedCount];
        if (next?.status === "queued") next.status = "running";
        const bytes = encodeSubtitleDocument(file.document, { bom: job.outputBom });
        queue(async () => {
          await files.put(outputKey(job.jobId), bytes);
          job.hasOutput = true;
          await service.commit({ putJobs: next === undefined ? [job] : [job, next] });
        });
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
    const detail = error instanceof Error ? error.message : String(error);
    input.log?.(`translation failed: ${detail}`);
    failJobs(
      data,
      batch,
      jobs,
      // A user-safe sentence, never a stack trace and never an error code
      // (section 2.3). The real reason goes to the server's own log.
      "This file could not be translated, so it was refunded to your balance. The server log has the reason.",
      environment.now(),
    );
  }

  // Every queued write has to have landed before the batch is settled: a
  // settled batch is what makes the app stop polling and offer the zip.
  await pending;

  const all = jobsOf(data, batch);
  settleBatch(batch, all, environment.now());
  await service.commit({
    account: data.account,
    putBatches: [batch],
    putJobs: all,
    replaceLedger: data.ledger,
  });

  return {
    done: all.filter((job) => job.status === "done").length,
    failed: all.filter((job) => job.status === "failed").length,
  };
}

function jobsOf(data: AccountData, batch: BatchRecord): JobRecord[] {
  const byId = new Map(data.jobs.map((job) => [job.jobId, job]));
  return batch.jobIds.flatMap((jobId) => {
    const job = byId.get(jobId);
    return job === undefined ? [] : [job];
  });
}

function find<T>(rows: readonly T[], id: string, idOf: (row: T) => string): T | null {
  return rows.find((row) => idOf(row) === id) ?? null;
}

/** A job whose document went missing still has to settle, not crash. */
function emptyDocumentOf(job: JobRecord): SubtitleDocument {
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
