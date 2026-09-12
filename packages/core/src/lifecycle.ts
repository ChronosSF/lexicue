import type { TargetLanguage, TranslationOptions as HarnessOptions } from "@lexicue/harness";
import { applyRefund, type Lane, type TranslationOptions } from "@lexicue/shared";
import type { SubtitleDocument } from "@lexicue/subtitles";
import {
  FILE_RETENTION_MS,
  HISTORY_RETENTION_MS,
  dayStamp,
  jobsOfBatch,
  outputKey,
  uploadKey,
  walletView,
  type AccountData,
  type BatchRecord,
  type JobRecord,
} from "./records.js";
import type { AccountChanges, FileStore } from "./stores.js";
import type { IntakeResult } from "./intake.js";

/**
 * The state machine of specification section 7.5, and the retention rules of
 * section 3.2, as functions over records.
 *
 * A job goes `queued` → `running` → `done`, or to `failed` from anywhere, and
 * a failure is always a refund: "partial results are never sold" (section 2.3).
 * A batch is `done`, `partial` or `failed` depending on its jobs, and nothing
 * else is allowed to decide that, which is why `settleBatch` is the only
 * function that writes a batch's terminal status.
 */

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

/** The harness's own options, from the contract's (spec sections 3.4 and 4.4). */
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

export interface PlannedBatch {
  batch: BatchRecord;
  jobs: JobRecord[];
  documents: SubtitleDocument[];
}

/**
 * Turns a priced intake into the rows section 7.4 stores, with the free portion
 * of the charge split across the files so a refund can restore exactly what a
 * file spent of the grant.
 */
export function planBatch(
  intake: IntakeResult,
  input: {
    batchId: string;
    jobId: () => string;
    options: TranslationOptions;
    lane: Lane;
    batchSize: number;
    fromFree: number;
    now: number;
  },
): PlannedBatch {
  let freeLeft = input.fromFree;
  const jobs = intake.files.map((file) => {
    const freeShare = Math.min(freeLeft, file.priceCents);
    freeLeft -= freeShare;
    return {
      jobId: input.jobId(),
      batchId: input.batchId,
      fileName: file.upload.fileName,
      outputFileName: outputFileName(file.upload.fileName, intake.target.code),
      sourceKey: uploadKey(file.upload.uploadId),
      status: "queued",
      lane: input.lane,
      format: file.document.format,
      encoding: file.document.encoding,
      cueCount: file.document.cues.length,
      dialogueChars: file.document.dialogueChars,
      runningTimeMs: runningTimeMs(file.document),
      priceCents: file.priceCents,
      freeChargedCents: freeShare,
      refundedCents: 0,
      sourceLanguage: null,
      batchesTotal: batchesFor(file.document.cues.length, input.batchSize),
      batchesDone: 0,
      error: null,
      hasOutput: false,
      outputBom: input.options.outputBom,
      report: null,
      createdAt: input.now,
      finishedAt: null,
    } satisfies JobRecord;
  });

  return {
    batch: {
      batchId: input.batchId,
      status: "queued",
      lane: input.lane,
      targetLanguage: intake.target.code,
      targetLanguageName: intake.target.name,
      options: input.options,
      priceCents: intake.totalCents,
      refundedCents: 0,
      jobIds: jobs.map((job) => job.jobId),
      seasonGlossary: null,
      messageBatchId: null,
      createdAt: input.now,
      finishedAt: null,
      filesExpireAt: null,
      filesDeleted: false,
    },
    jobs,
    documents: intake.files.map((file) => file.document),
  };
}

/** The description on the charge's ledger entry (spec section 2.2). */
export function chargeDescription(intake: IntakeResult): string {
  const first = intake.files[0];
  return intake.files.length === 1
    ? `Translated ${first?.upload.fileName ?? "one file"} into ${intake.target.name}`
    : `Translated ${intake.files.length.toString()} files into ${intake.target.name}`;
}

/** The counters section 7.4 keeps on the profile row, after a batch is created. */
export function bumpDailyCount(data: AccountData, count: number, now: number): void {
  const filesToday = data.account.filesTodayStamp === dayStamp(now) ? data.account.filesToday : 0;
  data.account.filesToday = filesToday + count;
  data.account.filesTodayStamp = dayStamp(now);
}

/**
 * Fails a set of jobs and refunds each one separately, restoring the free
 * portion it spent. Section 2.3: a failed file costs nothing, and the other
 * files of the upload are unaffected.
 */
export function failJobs(
  data: AccountData,
  batch: BatchRecord,
  jobs: readonly JobRecord[],
  message: string,
  now: number,
): JobRecord[] {
  const failed: JobRecord[] = [];
  for (const job of jobs) {
    if (job.status === "done" || job.status === "failed") continue;
    job.status = "failed";
    job.error = message;
    job.refundedCents = job.priceCents;
    job.finishedAt = now;
    batch.refundedCents += job.priceCents;
    applyRefund(walletView(data), {
      amountCents: job.priceCents,
      freeCents: job.freeChargedCents,
      ref: job.jobId,
      description: `Refund for ${job.fileName}`,
      now,
    });
    failed.push(job);
  }
  return failed;
}

/**
 * The one place a batch reaches a terminal status, and the one place the
 * 24-hour retention clock starts (spec section 3.2).
 */
export function settleBatch(batch: BatchRecord, jobs: readonly JobRecord[], now: number): void {
  const failed = jobs.filter((job) => job.status === "failed").length;
  batch.status = failed === 0 ? "done" : failed === jobs.length ? "failed" : "partial";
  batch.finishedAt = Math.max(now, ...jobs.map((job) => job.finishedAt ?? now));
  batch.filesExpireAt = batch.finishedAt + FILE_RETENTION_MS;
}

/** Deletes a batch's translated files, keeping the history row (spec 7.3). */
export async function deleteBatchFiles(
  data: AccountData,
  files: FileStore,
  batch: BatchRecord,
): Promise<JobRecord[]> {
  batch.filesDeleted = true;
  const touched: JobRecord[] = [];
  for (const job of jobsOfBatch(data, batch)) {
    await files.remove(outputKey(job.jobId));
    job.hasOutput = false;
    touched.push(job);
  }
  return touched;
}

/**
 * The two retention rules of section 3.2, applied on every request rather than
 * by a scheduled job: files 24 hours after a batch finishes, history after 30
 * days. In the deployed system an S3 lifecycle rule and a DynamoDB TTL do this,
 * which is why the changes it produces are a normal commit and nothing special.
 */
export async function prune(
  data: AccountData,
  files: FileStore,
  now: number,
): Promise<AccountChanges> {
  const putBatches: BatchRecord[] = [];
  const putJobs: JobRecord[] = [];

  for (const batch of data.batches) {
    if (batch.filesExpireAt === null || batch.filesExpireAt > now || batch.filesDeleted) continue;
    putBatches.push(batch);
    putJobs.push(...(await deleteBatchFiles(data, files, batch)));
  }

  const staleUploadIds: string[] = [];
  for (const upload of data.uploads) {
    if (now - upload.createdAt < FILE_RETENTION_MS) continue;
    await files.remove(uploadKey(upload.uploadId));
    staleUploadIds.push(upload.uploadId);
  }

  const expiredBatchIds = data.batches
    .filter((batch) => now - batch.createdAt > HISTORY_RETENTION_MS)
    .map((batch) => batch.batchId);
  const expired = new Set(expiredBatchIds);
  const expiredJobIds = data.jobs.filter((job) => expired.has(job.batchId)).map((job) => job.jobId);

  const keptLedger = data.ledger.filter(
    (entry) => now - new Date(entry.at).getTime() <= HISTORY_RETENTION_MS,
  );

  const changes: AccountChanges = {};
  if (putBatches.length > 0) changes.putBatches = putBatches;
  if (putJobs.length > 0) changes.putJobs = putJobs;
  if (staleUploadIds.length > 0) changes.deleteUploadIds = staleUploadIds;
  if (expiredBatchIds.length > 0) changes.deleteBatchIds = expiredBatchIds;
  if (expiredJobIds.length > 0) changes.deleteJobIds = expiredJobIds;
  if (keptLedger.length !== data.ledger.length) changes.replaceLedger = keptLedger;
  return changes;
}

/** True when a commit would write nothing, so the caller can skip it. */
export function isEmptyChanges(changes: AccountChanges): boolean {
  return Object.keys(changes).length === 0;
}
