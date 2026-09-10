import { DEFAULT_HARNESS_CONFIG } from "@subtitle-translator/harness";
import type { Batch, BatchSummary, Job } from "@subtitle-translator/shared";
import { buildZip, type DownloadUrls } from "./bytes.js";
import { outputBytes } from "./translate.js";
import type { MockState, MockTiming, StoredBatch, StoredJob } from "./state.js";

/**
 * Turns the stored rows into the wire shapes of spec section 7.3. This is the
 * only place that knows about download URLs: in the deployed system they are
 * presigned S3 GETs minted on every poll, and here they are object URLs minted
 * once and kept, which behaves the same from the browser's point of view.
 */

/** Cues per model request, which is what a progress bar counts (spec 4.4). */
export function batchesFor(cueCount: number): number {
  return Math.max(1, Math.ceil(cueCount / DEFAULT_HARNESS_CONFIG.batchSize));
}

/** Batches completed out of total, from the clock (spec section 2.1). */
export function progressOf(job: StoredJob, now: number): number {
  if (job.status === "done" || job.status === "failed") return job.batchesTotal;
  if (now <= job.startAt) return 0;
  const span = Math.max(1, job.endAt - job.startAt);
  const share = Math.min(1, (now - job.startAt) / span);
  // The last batch only lands when the file is settled, so a bar never sits at
  // 100% next to a row that still says "translating".
  return Math.min(job.batchesTotal - 1, Math.floor(share * job.batchesTotal));
}

export function toJobView(job: StoredJob, now: number, urls: DownloadUrls): Job {
  const downloadable = job.status === "done" && job.outputText !== null;
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
    batchesDone: progressOf(job, now),
    downloadUrl: downloadable
      ? urls.get(job.jobId, () => ({
          bytes: outputBytes(job.outputText ?? "", job.outputBom),
          mime: "text/plain;charset=utf-8",
        }))
      : null,
    report: job.report,
    // The sentence belongs to a file that has failed, not to one that is going
    // to: a queued row must not announce its own refund in advance.
    error: job.status === "failed" ? job.failReason : null,
    createdAt: new Date(job.createdAt).toISOString(),
    finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
  };
}

export function jobsOf(state: MockState, batch: StoredBatch): StoredJob[] {
  const byId = new Map(state.jobs.map((job) => [job.jobId, job]));
  return batch.jobIds.flatMap((jobId) => {
    const job = byId.get(jobId);
    return job === undefined ? [] : [job];
  });
}

export function toBatchView(
  state: MockState,
  batch: StoredBatch,
  now: number,
  timing: MockTiming,
  urls: DownloadUrls,
): Batch {
  const jobs = jobsOf(state, batch);
  const views = jobs.map((job) => toJobView(job, now, urls));
  const finished = jobs.filter((job) => job.status === "done");

  const zipUrl =
    batch.status !== "queued" &&
    finished.length > 1 &&
    jobs.every((job) => job.status === "done" || job.status === "failed") &&
    finished.every((job) => job.outputText !== null)
      ? urls.get(`${batch.batchId}:zip`, () => ({
          bytes: buildZip(
            finished.map((job) => ({
              name: job.outputFileName,
              bytes: outputBytes(job.outputText ?? "", job.outputBom),
            })),
          ),
          mime: "application/zip",
        }))
      : null;

  return {
    batchId: batch.batchId,
    status: batch.status,
    lane: batch.lane,
    targetLanguage: batch.targetLanguage,
    targetLanguageName: batch.targetLanguageName,
    options: batch.options,
    fileCount: jobs.length,
    doneCount: finished.length,
    failedCount: jobs.filter((job) => job.status === "failed").length,
    priceCents: batch.priceCents,
    refundedCents: batch.refundedCents,
    jobs: views,
    seasonGlossary: batch.seasonGlossary,
    zipUrl,
    zipFileName: zipUrl === null ? null : zipFileName(batch),
    notice: noticeFor(batch, jobs, timing),
    pollAfterMs: batch.lane === "economy" ? timing.pollEconomyMs : timing.pollFastMs,
    createdAt: new Date(batch.createdAt).toISOString(),
    finishedAt: batch.finishedAt === null ? null : new Date(batch.finishedAt).toISOString(),
    filesExpireAt:
      batch.filesExpireAt === null || batch.filesDeleted
        ? null
        : new Date(batch.filesExpireAt).toISOString(),
  };
}

export function toBatchSummary(
  state: MockState,
  batch: StoredBatch,
  now: number,
  timing: MockTiming,
  urls: DownloadUrls,
): BatchSummary {
  // A history row carries the batch without its jobs; the file names are what
  // the list shows in their place.
  const { jobs, seasonGlossary, ...rest } = toBatchView(state, batch, now, timing, urls);
  return { ...rest, fileNames: jobs.map((job) => job.fileName) };
}

function zipFileName(batch: StoredBatch): string {
  return `subtitles-${batch.targetLanguage}-${batch.batchId.replace(/^bat_/, "")}.zip`;
}

/**
 * The sentence above the file rows. Spec section 2.3 asks for the rate limit to
 * read as a plain sentence, and section 2.1 for the economy lane to say that
 * the user can leave.
 */
function noticeFor(batch: StoredBatch, jobs: StoredJob[], timing: MockTiming): string | null {
  const running = jobs.filter((job) => job.status === "running").length;
  const waiting = jobs.filter((job) => job.status === "queued").length;

  if (batch.lane === "economy") {
    if (jobs.some((job) => job.status === "submitted")) {
      return "Submitted. These usually come back within the hour and always within 24 hours, so you can close this page: an email arrives when the upload is complete.";
    }
    return null;
  }

  if (waiting > 0 && running >= timing.fastConcurrency) {
    return `${capitalise(numberWord(running))} files are already translating, the rest will start as they finish.`;
  }
  return null;
}

function numberWord(count: number): string {
  const words = ["no", "one", "two", "three", "four", "five", "six"];
  return words[count] ?? count.toString();
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
