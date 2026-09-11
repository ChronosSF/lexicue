import { createHmac, timingSafeEqual } from "node:crypto";
import type { Batch, BatchSummary, Job } from "@lexicue/shared";
import { CONCURRENT_FAST_FILES } from "@lexicue/shared";
import type { DevBatch, DevJob, DevState } from "./state.js";

/**
 * The stored rows as the wire shapes of spec section 7.3.
 *
 * The only thing this file knows that the rest does not is how a finished file
 * becomes a URL. In the deployed system that is a presigned S3 GET valid for
 * fifteen minutes; here it is the same idea with a smaller signature, so the
 * browser can follow a plain link without an Authorization header exactly as it
 * will against S3.
 */

/** Spec section 7.3: two seconds on the fast lane, thirty on the economy lane. */
export const POLL_FAST_MS = 2_000;
export const POLL_ECONOMY_MS = 30_000;

/** How long a download link lives, as spec section 7.2 sets it for S3. */
export const DOWNLOAD_TTL_MS = 15 * 60 * 1000;

export class DownloadLinks {
  private readonly secret: Buffer;

  constructor(secret: Buffer) {
    this.secret = secret;
  }

  /** `/api/dev/files/{id}?expires=…&signature=…`, a presigned GET in miniature. */
  sign(path: string, id: string, now: number): string {
    const expires = now + DOWNLOAD_TTL_MS;
    const signature = this.mac(id, expires);
    return `${path}?expires=${expires.toString()}&signature=${signature}`;
  }

  verify(id: string, expires: string | null, signature: string | null, now: number): boolean {
    if (expires === null || signature === null) return false;
    const expiry = Number(expires);
    if (!Number.isFinite(expiry) || expiry < now) return false;
    const expected = Buffer.from(this.mac(id, expiry), "utf8");
    const given = Buffer.from(signature, "utf8");
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private mac(id: string, expires: number): string {
    return createHmac("sha256", this.secret).update(`${id}:${expires.toString()}`).digest("hex");
  }
}

export function jobsOf(state: DevState, batch: DevBatch): DevJob[] {
  const byId = new Map(state.jobs.map((job) => [job.jobId, job]));
  return batch.jobIds.flatMap((jobId) => {
    const job = byId.get(jobId);
    return job === undefined ? [] : [job];
  });
}

export function toJobView(job: DevJob, links: DownloadLinks, now: number): Job {
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
    downloadUrl:
      job.status === "done" && job.hasOutput
        ? links.sign(`/api/dev/files/${job.jobId}`, job.jobId, now)
        : null,
    report: job.report,
    error: job.status === "failed" ? job.error : null,
    createdAt: new Date(job.createdAt).toISOString(),
    finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
  };
}

export function toBatchView(
  state: DevState,
  batch: DevBatch,
  links: DownloadLinks,
  now: number,
): Batch {
  const jobs = jobsOf(state, batch);
  const views = jobs.map((job) => toJobView(job, links, now));
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
    zipUrl: zipReady
      ? links.sign(`/api/dev/files/${batch.batchId}/zip`, `${batch.batchId}:zip`, now)
      : null,
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
  state: DevState,
  batch: DevBatch,
  links: DownloadLinks,
  now: number,
): BatchSummary {
  const { jobs, seasonGlossary, ...rest } = toBatchView(state, batch, links, now);
  return { ...rest, fileNames: jobs.map((job) => job.fileName) };
}

export function zipFileName(batch: DevBatch): string {
  return `subtitles-${batch.targetLanguage}-${batch.batchId.replace(/^bat_/, "")}.zip`;
}

/**
 * The sentence above the file rows. Spec section 3.2 allows three files at once
 * on the fast lane, but the harness translates a multi-file upload in order on
 * purpose: that ordering is what lets a character introduced in episode two
 * reach episode three (see the handover note in the root README). So the notice
 * says what is actually happening rather than quoting a limit nothing hit.
 */
function noticeFor(batch: DevBatch, jobs: readonly DevJob[]): string | null {
  if (batch.status === "done" || batch.status === "partial" || batch.status === "failed") {
    return null;
  }
  if (jobs.length <= 1) return null;
  return `Translating ${jobs.length.toString()} files in order, so names and register carry from one to the next. Up to ${CONCURRENT_FAST_FILES.toString()} run at once in the deployed system; here they run one at a time.`;
}
