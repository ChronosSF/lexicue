import type {
  BatchStatus,
  FileReport,
  JobStatus,
  Lane,
  LedgerEntry,
  SeasonGlossarySummary,
  SubtitleFormat,
  TranslationOptions,
  WalletState,
} from "@lexicue/shared";

/**
 * The stored rows of specification section 7.4, with no storage in them.
 *
 * Section 7.4 puts everything belonging to one user in one DynamoDB partition,
 * `USER#{sub}`, with a different sort key per kind of row: `PROFILE`,
 * `BATCH#{ulid}`, `JOB#{ulid}`, `LEDGER#{timestamp}#{ulid}`. These interfaces
 * are those rows. Money is integer cents everywhere, the ledger is append-only,
 * and file bytes are never in here: they live in a {@link FileStore} under the
 * keys of section 7.2.
 *
 * Nothing in this file knows whether it came from DynamoDB, a JSON file or a
 * `Map`, which is the point: the same rules charge the same wallet in a Lambda
 * and in `pnpm dev`.
 */

/** Files are deleted 24 hours after a job finishes (spec section 3.2). */
export const FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** History with no text in it is kept for 30 days (spec sections 2.2 and 3.2). */
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface UserRecord {
  userId: string;
  email: string;
  emailVerified: boolean;
  createdAt: number;
}

/**
 * The `PROFILE` row: who the user is, what they have, what they have used.
 *
 * The ledger is deliberately not in here. Section 7.4 stores it as its own
 * `LEDGER#{timestamp}#{ulid}` rows, append-only, so the profile stays small and
 * an entry is never rewritten. {@link walletView} is what hands the two of them
 * to the wallet rules in `@lexicue/shared` as the one object those rules expect.
 */
export interface AccountRecord {
  user: UserRecord | null;
  balanceCents: number;
  /** The unspent part of the $2.50 grant, shown separately while it lasts. */
  freeCents: number;
  /**
   * The development stand-in for a Cognito id token. Cognito issues and
   * validates the real one at the API Gateway authorizer, before any of this
   * code runs, so a deployed adapter leaves this null and never reads it.
   */
  authToken: string | null;
  /**
   * Emails that have had their one free balance. Section 6.8 keeps a hashed
   * email so deleting and recreating an account cannot earn a second grant;
   * one developer on one machine does not need the hash.
   */
  grantedEmails: string[];
  /** The 100-files-a-day counter of section 3.2, with the day it belongs to. */
  filesToday: number;
  filesTodayStamp: string;
}

/** An upload slot. The bytes are in the file store under `uploads/{uploadId}`. */
export interface UploadRecord {
  uploadId: string;
  fileName: string;
  byteLength: number;
  received: boolean;
  createdAt: number;
}

/** The `JOB#{ulid}` row: one file of one upload. */
export interface JobRecord {
  jobId: string;
  batchId: string;
  fileName: string;
  outputFileName: string;
  /**
   * Where the uploaded bytes are, as section 7.4's `sourceKey`. A job cannot
   * derive it: the upload id it came from is not the job id, and a worker that
   * picks a message off a queue has to be able to re-read what was charged for.
   */
  sourceKey: string;
  status: JobStatus;
  lane: Lane;
  format: SubtitleFormat;
  encoding: string;
  cueCount: number;
  dialogueChars: number;
  runningTimeMs: number;
  priceCents: number;
  /** How much of the price came out of the free grant, so a refund restores it. */
  freeChargedCents: number;
  refundedCents: number;
  sourceLanguage: string | null;
  batchesTotal: number;
  /** Real progress: the harness reports this after every batch (spec 7.5). */
  batchesDone: number;
  /** The plain sentence a failed file shows, or null (spec section 2.3). */
  error: string | null;
  /** Whether `outputs/{jobId}` exists in the file store. */
  hasOutput: boolean;
  outputBom: boolean;
  report: FileReport | null;
  createdAt: number;
  finishedAt: number | null;
}

/** The `BATCH#{ulid}` row: one upload, one target language, one lane. */
export interface BatchRecord {
  batchId: string;
  status: BatchStatus;
  lane: Lane;
  targetLanguage: string;
  targetLanguageName: string;
  options: TranslationOptions;
  priceCents: number;
  refundedCents: number;
  jobIds: string[];
  seasonGlossary: SeasonGlossarySummary | null;
  /** The Message Batch this upload's requests went into, on the economy lane. */
  messageBatchId: string | null;
  createdAt: number;
  finishedAt: number | null;
  filesExpireAt: number | null;
  filesDeleted: boolean;
}

/**
 * A top-up in progress. In the deployed system this is the Stripe Checkout
 * Session and the marker row of section 6.6 that makes crediting idempotent;
 * `credited` is that marker.
 */
export interface CheckoutRecord {
  sessionId: string;
  amountCents: number;
  status: "open" | "paid";
  createdAt: number;
  credited: boolean;
}

/**
 * A Stripe event this account has already acted on: the idempotency marker of
 * specification section 6.6, so a redelivered event cannot credit twice.
 *
 * Section 7.4 puts it in its own partition, `STRIPE#{eventId}`. It is in the
 * user's partition here, as `STRIPE#{eventId}` under `USER#{sub}`, for one
 * reason: the marker and the credit have to be the same write, and this store's
 * unit of work is one partition. DynamoDB's `TransactWriteItems` can span
 * partitions, so 7.4's layout would also work — but co-locating them means the
 * marker cannot be orphaned from the money it guards, and the 90-day expiry the
 * section asks for still applies.
 */
export interface StripeEventRecord {
  eventId: string;
  type: string;
  amountCents: number;
  processedAt: number;
}

/** Stripe event markers expire after 90 days (spec section 7.4). */
export const STRIPE_MARKER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Everything in one user's partition. In DynamoDB this is the result of a
 * single `Query` on `PK = USER#{sub}`, sorted into its kinds.
 */
export interface AccountData {
  account: AccountRecord;
  uploads: UploadRecord[];
  batches: BatchRecord[];
  jobs: JobRecord[];
  ledger: LedgerEntry[];
  checkouts: CheckoutRecord[];
  stripeEvents: StripeEventRecord[];
}

/**
 * The profile row and the ledger rows as the single mutable object the wallet
 * rules of `@lexicue/shared` are written against. The getters read through and
 * the setters write back, so `applyCharge` and friends change the records
 * themselves rather than a copy, and the ledger stays the same array they push
 * onto. This exists so the arithmetic can be shared with the browser mock,
 * which keeps its balance in an entirely different shape.
 */
export function walletView(data: AccountData): WalletState {
  return {
    get balanceCents(): number {
      return data.account.balanceCents;
    },
    set balanceCents(value: number) {
      data.account.balanceCents = value;
    },
    get freeCents(): number {
      return data.account.freeCents;
    },
    set freeCents(value: number) {
      data.account.freeCents = value;
    },
    get ledger(): LedgerEntry[] {
      return data.ledger;
    },
  };
}

export function emptyAccount(): AccountData {
  return {
    account: {
      user: null,
      authToken: null,
      balanceCents: 0,
      freeCents: 0,
      grantedEmails: [],
      filesToday: 0,
      filesTodayStamp: "",
    },
    uploads: [],
    batches: [],
    jobs: [],
    ledger: [],
    checkouts: [],
    stripeEvents: [],
  };
}

/** The day a file count belongs to, for the 100-files-a-day limit. */
export function dayStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The jobs of one batch, in the order the batch lists them. */
export function jobsOfBatch(data: AccountData, batch: BatchRecord): JobRecord[] {
  const byId = new Map(data.jobs.map((job) => [job.jobId, job]));
  return batch.jobIds.flatMap((jobId) => {
    const job = byId.get(jobId);
    return job === undefined ? [] : [job];
  });
}

/** The object key of section 7.2 for an uploaded file. */
export function uploadKey(uploadId: string): string {
  return `uploads/${uploadId}`;
}

/** The object key of section 7.2 for a translated file. */
export function outputKey(jobId: string): string {
  return `outputs/${jobId}`;
}
