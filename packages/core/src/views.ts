import { CONCURRENT_FAST_FILES, type Batch, type BatchSummary, type Job } from "@lexicue/shared";
import { jobsOfBatch, type AccountData, type BatchRecord, type JobRecord } from "./records.js";
import type { DownloadSigner } from "./stores.js";

/**
 * The stored rows as the wire shapes of specification section 7.3.
 *
 * This is the only place that decides what a client is told, so the app and a
 * Lambda cannot disagree about it. Download URLs come from a
 * {@link DownloadSigner} because that is the one part of the answer that
 * depends on where the bytes are: a presigned S3 GET in the deployed system,
 * a signed local link in development.
 */

/** Spec section 7.3: two seconds on the fast lane, thirty on the economy lane. */
export const POLL_FAST_MS = 2_000;
export const POLL_ECONOMY_MS = 30_000;

export function toJobView(job: JobRecord, signer: DownloadSigner, now: number): Job {
  return {
    jobId: job.jobId,
    batchId: job.batchId,
    fileName: job.fileName,
    outputFileName: job.outputFileName,
    status: job.status,
    lane: job.lane,
    format: job.format,
    encoding: job.encoding,
    cueCount: job.cueCount,
    dialogueChars: job.dialogueChars,
    runningTimeMs: job.runningTimeMs,
    priceCents: job.priceCents,
    refundedCents: job.refundedCents,
    sourceLanguage: job.sourceLanguage,
    batchesTotal: job.batchesTotal,
    batchesDone: job.batchesDone,
    downloadUrl: job.status === "done" && job.hasOutput ? signer.fileUrl(job.jobId, now) : null,
    report: job.report,
    error: job.status === "failed" ? job.error : null,
    createdAt: new Date(job.createdAt).toISOString(),
    finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
  };
}

export function toBatchView(
  data: AccountData,
  batch: BatchRecord,
  signer: DownloadSigner,
  now: number,
): Batch {
  const jobs = jobsOfBatch(data, batch);
  const views = jobs.map((job) => toJobView(job, signer, now));
  const finished = jobs.filter((job) => job.status === "done" && job.hasOutput);
  const settled = jobs.every((job) => job.status === "done" || job.status === "failed");
  const zipReady = settled && finished.length > 1 && !batch.filesDeleted;

  return {
    batchId: batch.batchId,
    status: batch.status,
    lane: batch.lane,
    targetLanguage: batch.targetLanguage,
    targetLanguageName: batch.targetLanguageName,
    options: batch.options,
    fileCount: jobs.length,
    doneCount: jobs.filter((job) => job.status === "done").length,
    failedCount: jobs.filter((job) => job.status === "failed").length,
    priceCents: batch.priceCents,
    refundedCents: batch.refundedCents,
    jobs: views,
    seasonGlossary: batch.seasonGlossary,
    zipUrl: zipReady ? signer.zipUrl(batch.batchId, now) : null,
    zipFileName: zipReady ? zipFileName(batch) : null,
    notice: noticeFor(batch, jobs),
    pollAfterMs: batch.lane === "economy" ? POLL_ECONOMY_MS : POLL_FAST_MS,
    createdAt: new Date(batch.createdAt).toISOString(),
    finishedAt: batch.finishedAt === null ? null : new Date(batch.finishedAt).toISOString(),
    filesExpireAt:
      batch.filesExpireAt === null || batch.filesDeleted
        ? null
        : new Date(batch.filesExpireAt).toISOString(),
  };
}

export function toBatchSummary(
  data: AccountData,
  batch: BatchRecord,
  signer: DownloadSigner,
  now: number,
): BatchSummary {
  const { jobs, seasonGlossary, ...rest } = toBatchView(data, batch, signer, now);
  return { ...rest, fileNames: jobs.map((job) => job.fileName) };
}

export function zipFileName(batch: BatchRecord): string {
  return `subtitles-${batch.targetLanguage}-${batch.batchId.replace(/^bat_/, "")}.zip`;
}

/**
 * The sentence above the file rows. Spec section 3.2 allows three files at once
 * on the fast lane, but the harness translates a multi-file upload in order on
 * purpose: that ordering is what lets a character introduced in episode two
 * reach episode three (see the handover note in the root README). So the notice
 * says what is actually happening rather than quoting a limit nothing hit.
 */
function noticeFor(batch: BatchRecord, jobs: readonly JobRecord[]): string | null {
  if (batch.status === "done" || batch.status === "partial" || batch.status === "failed") {
    return null;
  }
  if (jobs.length <= 1) return null;
  return `Translating ${jobs.length.toString()} files in order, so names and register carry from one to the next. Up to ${CONCURRENT_FAST_FILES.toString()} run at once in the deployed system; here they run one at a time.`;
}

/** A name no other entry in the zip has, so a folder drop cannot overwrite. */
export function uniqueZipEntryName(taken: ReadonlySet<string>, name: string): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  for (let attempt = 2; ; attempt += 1) {
    const candidate =
      dot <= 0
        ? `${name} (${attempt.toString()})`
        : `${name.slice(0, dot)} (${attempt.toString()})${name.slice(dot)}`;
    if (!taken.has(candidate)) return candidate;
  }
}
