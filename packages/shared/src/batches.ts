import { z } from "zod";
import {
  CentsSchema,
  IdSchema,
  InstantSchema,
  LaneSchema,
  SubtitleFormatSchema,
  TranslationOptionsSchema,
} from "./common.js";
import { FileReportSchema, SeasonGlossarySummarySchema } from "./reports.js";

/**
 * `POST /api/batches`, `GET /api/batches/{id}`, `GET /api/batches` and
 * `DELETE /api/batches/{id}` of spec section 7.3. A single file is a batch with
 * one file, so there is one code path.
 */

/** The states of spec section 7.4, per file. */
export const JobStatusSchema = z.enum([
  "queued",
  "running",
  /** Economy lane: handed to the Message Batches API and waiting. */
  "submitted",
  "done",
  "failed",
]);

/** The states of spec section 7.4, per batch. */
export const BatchStatusSchema = z.enum([
  "queued",
  "running",
  "submitted",
  "done",
  /** Some files finished and some were refunded. */
  "partial",
  "failed",
]);

export const JobSchema = z.object({
  jobId: IdSchema,
  batchId: IdSchema,
  fileName: z.string(),
  /** `original-name.de.srt` once the file finishes (spec section 2.1). */
  outputFileName: z.string(),
  status: JobStatusSchema,
  lane: LaneSchema,
  format: SubtitleFormatSchema,
  encoding: z.string(),
  cueCount: z.int(),
  dialogueChars: z.int(),
  runningTimeMs: z.int(),
  priceCents: CentsSchema,
  /** Cents put back after a failure (spec section 2.3). */
  refundedCents: CentsSchema,
  sourceLanguage: z.string().nullable(),
  batchesTotal: z.int(),
  batchesDone: z.int(),
  /** Present while the file is downloadable; files are deleted after 24 hours. */
  downloadUrl: z.string().nullable(),
  report: FileReportSchema.nullable(),
  /** A plain sentence, never an error code (spec section 2.3). */
  error: z.string().nullable(),
  createdAt: InstantSchema,
  finishedAt: InstantSchema.nullable(),
});

export const BatchSchema = z.object({
  batchId: IdSchema,
  status: BatchStatusSchema,
  lane: LaneSchema,
  targetLanguage: z.string(),
  targetLanguageName: z.string(),
  options: TranslationOptionsSchema,
  fileCount: z.int(),
  doneCount: z.int(),
  failedCount: z.int(),
  priceCents: CentsSchema,
  refundedCents: CentsSchema,
  jobs: z.array(JobSchema),
  seasonGlossary: SeasonGlossarySummarySchema.nullable(),
  /** The "Download all" zip, once the last file has finished. */
  zipUrl: z.string().nullable(),
  zipFileName: z.string().nullable(),
  /**
   * A sentence to show above the file rows: the economy lane's wait, or the
   * three-at-a-time rule of spec section 3.2. Null when there is nothing to say.
   */
  notice: z.string().nullable(),
  /** What the SPA should wait before polling again (2 s fast, 30 s economy). */
  pollAfterMs: z.int(),
  createdAt: InstantSchema,
  finishedAt: InstantSchema.nullable(),
  /** When the files are deleted; history outlives them by 30 days (3.2). */
  filesExpireAt: InstantSchema.nullable(),
});

/** One row of the history list; the jobs are summarised, not repeated. */
export const BatchSummarySchema = BatchSchema.omit({ jobs: true, seasonGlossary: true }).extend({
  fileNames: z.array(z.string()),
});

export const CreateBatchRequestSchema = z.object({
  uploadIds: z.array(IdSchema).min(1).max(50),
  targetLanguage: z.string().min(2),
  lane: LaneSchema,
  options: TranslationOptionsSchema,
});

/** 202 with the batch and its jobs (spec section 7.3). */
export const CreateBatchResponseSchema = z.object({
  batch: BatchSchema,
  /** The wallet after the charge, so the header updates without a second call. */
  balanceCents: CentsSchema,
  freeCents: CentsSchema,
});

export const BatchResponseSchema = z.object({ batch: BatchSchema });

export const BatchListResponseSchema = z.object({ batches: z.array(BatchSummarySchema) });

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type BatchStatus = z.infer<typeof BatchStatusSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Batch = z.infer<typeof BatchSchema>;
export type BatchSummary = z.infer<typeof BatchSummarySchema>;
export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>;
export type CreateBatchResponse = z.infer<typeof CreateBatchResponseSchema>;
export type BatchResponse = z.infer<typeof BatchResponseSchema>;
export type BatchListResponse = z.infer<typeof BatchListResponseSchema>;

/** True while anything in the batch can still change. */
export function isBatchRunning(batch: { status: BatchStatus }): boolean {
  return batch.status === "queued" || batch.status === "running" || batch.status === "submitted";
}
