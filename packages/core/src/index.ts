/**
 * The authoritative logic of the product, with no storage and no transport.
 *
 * Everything that decides what a file is, what it costs, what the wallet does
 * and what state an upload is in lives here, behind the store interfaces in
 * `stores.ts`. `packages/dev-api` is an HTTP adapter over it; the Lambda
 * handlers, the DynamoDB store and the S3 store of Phase 2 are adapters of the
 * same kind.
 */

export {
  FILE_RETENTION_MS,
  HISTORY_RETENTION_MS,
  dayStamp,
  emptyAccount,
  jobsOfBatch,
  outputKey,
  uploadKey,
  walletView,
  type AccountData,
  type AccountRecord,
  type BatchRecord,
  type CheckoutRecord,
  type JobRecord,
  type UploadRecord,
  type UserRecord,
} from "./records.js";

export {
  ConcurrentWriteError,
  NO_DOWNLOADS,
  type AccountChanges,
  type CoreEnvironment,
  type DownloadSigner,
  type FileStore,
  type MetadataStore,
} from "./stores.js";

export { InMemoryFileStore, InMemoryMetadataStore, applyChanges } from "./memory.js";

export {
  assertUploadRequestWithinLimits,
  filesTodayFor,
  intake,
  requireTargetLanguage,
  type IntakeFile,
  type IntakeResult,
} from "./intake.js";

export {
  batchesFor,
  bumpDailyCount,
  chargeDescription,
  deleteBatchFiles,
  failJobs,
  harnessOptions,
  isEmptyChanges,
  outputFileName,
  planBatch,
  prune,
  runningTimeMs,
  settleBatch,
  type PlannedBatch,
} from "./lifecycle.js";

export {
  POLL_ECONOMY_MS,
  POLL_FAST_MS,
  toBatchSummary,
  toBatchView,
  toJobView,
  uniqueZipEntryName,
  zipFileName,
} from "./views.js";

export { validateRequest } from "./validation.js";

export { runUpload, type RunUploadInput, type UploadOutcome } from "./worker.js";

export {
  ApiService,
  requireBatch,
  requireVerified,
  type ApiServiceOptions,
  type StartedBatch,
} from "./service.js";
