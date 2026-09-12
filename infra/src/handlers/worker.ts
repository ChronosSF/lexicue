import {
  ApiService,
  NO_DOWNLOADS,
  jobsOfBatch,
  type DownloadSigner,
  type FileStore,
  type MetadataStore,
  type PlannedBatch,
} from "@lexicue/core";
import { newId } from "@lexicue/shared";
import type { TranslationModelClient } from "@lexicue/harness";
import { parseSubtitleBytes } from "@lexicue/subtitles/encoding";

/**
 * The worker Lambda of specification sections 7.2 and 7.5: one SQS message per
 * file, the harness, the output in S3, the job row settled.
 *
 * It is a thin adapter over `ApiService.translate`, which is the same function
 * `pnpm dev` calls in its own process. What this file adds is the two things
 * only a queue consumer knows: how to turn `{userId, batchId, jobId}` into the
 * work the core wants, and what to tell SQS afterwards.
 *
 * Partial batch failures are reported rather than thrown. With
 * `reportBatchItemFailures` on the event source, returning the ids of the
 * messages that failed lets SQS redeliver exactly those; throwing would
 * redeliver the whole receive, and section 7.5 is explicit that the second
 * failure of a *file* is what belongs in the dead-letter queue.
 */

/** The message body the API Lambda sends, one per file (spec section 7.5). */
export interface JobMessage {
  userId: string;
  batchId: string;
  jobId: string;
}

/** The fields of an SQS event this handler reads. */
export interface QueueEvent {
  Records: { messageId: string; body: string }[];
}

export interface QueueResult {
  batchItemFailures: { itemIdentifier: string }[];
}

export interface WorkerDependencies {
  /** Built per message: the stores are scoped to one user's partition. */
  storesFor: (userId: string) => { metadata: MetadataStore; files: FileStore };
  client: TranslationModelClient;
  downloads?: DownloadSigner;
  now?: () => number;
  batchSize?: number;
  log?: (line: string) => void;
}

/**
 * Rebuilds the work the core planned, from the rows and the uploaded bytes.
 *
 * The documents are re-parsed from S3 rather than carried in the message
 * because an SQS body is capped at 256 KB and a subtitle file is capped at
 * 5 MB (section 3.2). Re-parsing is also the honest thing: the bytes in the
 * bucket are what was charged for.
 */
export async function workFor(
  service: ApiService,
  files: FileStore,
  message: JobMessage,
): Promise<PlannedBatch | null> {
  const data = await service.load();
  const batch = data.batches.find((row) => row.batchId === message.batchId);
  if (batch === undefined) return null;
  const job = data.jobs.find((row) => row.jobId === message.jobId);
  if (job === undefined || job.status === "done" || job.status === "failed") return null;

  // One message is one file, but the season glossary of section 4.4 needs the
  // whole upload, so the first message to arrive takes all of the batch's
  // files. The conditional write section 7.5 describes is what keeps that from
  // happening twice; it is the piece this handler still owes.
  const jobs = jobsOfBatch(data, batch).filter((row) => row.status === "queued");
  const documents = [];
  for (const row of jobs) {
    const bytes = await files.get(row.sourceKey);
    if (bytes === null) return null;
    documents.push(parseSubtitleBytes(bytes, { fileName: row.fileName }));
  }
  return { batch, jobs, documents };
}

export async function consume(
  event: QueueEvent,
  dependencies: WorkerDependencies,
): Promise<QueueResult> {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as JobMessage;
      const stores = dependencies.storesFor(message.userId);
      const service = new ApiService({
        metadata: stores.metadata,
        files: stores.files,
        downloads: dependencies.downloads ?? NO_DOWNLOADS,
        environment: { now: dependencies.now ?? ((): number => Date.now()), newId },
        ...(dependencies.batchSize === undefined ? {} : { batchSize: dependencies.batchSize }),
      });
      const work = await workFor(service, stores.files, message);
      // Nothing to do is a success: the file is already settled, or another
      // invocation took the upload. Redelivering would only repeat that.
      if (work === null) continue;
      await service.translate(work, dependencies.client, {
        ...(dependencies.batchSize === undefined ? {} : { batchSize: dependencies.batchSize }),
      });
    } catch (error) {
      dependencies.log?.(
        `worker failed on ${record.messageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}

/**
 * The Lambda entry point. Its stores are the unimplemented AWS ones, so it
 * fails closed until there is an account; `consume` is what the tests drive.
 */
export async function handler(event: QueueEvent): Promise<QueueResult> {
  const { DynamoMetadataStore, S3FileStore } = await import("../adapters/aws-stores.js");
  const { AnthropicTranslationClient } = await import("@lexicue/harness");
  return consume(event, {
    storesFor: (userId) => ({
      metadata: new DynamoMetadataStore({ tableName: process.env["LEXICUE_TABLE"] ?? "", userId }),
      files: new S3FileStore(process.env["LEXICUE_FILES_BUCKET"] ?? ""),
    }),
    // Section 9.8: the key comes from Secrets Manager at cold start, never from
    // an environment variable. Reading it is the other piece this owes.
    client: new AnthropicTranslationClient({ apiKey: "" }),
    log: (line) => {
      console.error(line);
    },
  });
}
