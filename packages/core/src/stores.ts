import type { AccountData } from "./records.js";

/**
 * What the core needs from the world, and nothing more.
 *
 * There are exactly three things: somewhere to keep the rows of specification
 * section 7.4, somewhere to keep file bytes under the keys of section 7.2, and
 * a clock and an id source so a test can make both deterministic. Everything
 * else the core does is arithmetic and rules.
 *
 * Both store interfaces are deliberately shaped like the AWS calls a Phase 2
 * adapter would make, so that adapter is a translation and not a design:
 *
 * - {@link MetadataStore.load} is one DynamoDB `Query` on `PK = USER#{sub}`,
 *   which is what section 7.4's single-table layout makes it.
 * - {@link MetadataStore.commit} is one `TransactWriteItems`. Section 7.4 says
 *   charging is one transaction — a conditional update on the profile, a put of
 *   the batch, a put per job and a put of the ledger entry — and that is
 *   exactly what one commit with `requireBalanceAtLeast` is.
 * - {@link FileStore} is `PutObject`, `GetObject` and `DeleteObject`.
 */

/** A commit whose condition no longer held: somebody else spent the money. */
export class ConcurrentWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentWriteError";
  }
}

/**
 * The items to write, atomically. Anything left out is untouched, so a commit
 * is the set of rows that changed rather than a whole-account snapshot — which
 * is what lets DynamoDB write only the items it has to.
 */
export interface AccountChanges {
  account?: AccountData["account"];
  putUploads?: readonly AccountData["uploads"][number][];
  deleteUploadIds?: readonly string[];
  putBatches?: readonly AccountData["batches"][number][];
  deleteBatchIds?: readonly string[];
  putJobs?: readonly AccountData["jobs"][number][];
  deleteJobIds?: readonly string[];
  appendLedger?: readonly AccountData["ledger"][number][];
  /** Retention only: the ledger is append-only apart from expiry. */
  replaceLedger?: readonly AccountData["ledger"][number][];
  putCheckouts?: readonly AccountData["checkouts"][number][];
  /** The idempotency markers of section 6.6, written with the credit. */
  putStripeEvents?: readonly AccountData["stripeEvents"][number][];
  replaceStripeEvents?: readonly AccountData["stripeEvents"][number][];
  /**
   * The condition of section 7.4's charging transaction: refuse the whole
   * commit unless the stored balance is still at least this many cents. In
   * DynamoDB it is a `ConditionExpression` on the profile item.
   */
  requireBalanceAtLeast?: number;
}

export interface MetadataStore {
  /** Every row of this user's partition, or null if the account is new. */
  load: () => Promise<AccountData | null>;
  /**
   * Writes `changes` atomically. Throws {@link ConcurrentWriteError} when
   * `requireBalanceAtLeast` no longer holds, and writes nothing.
   */
  commit: (changes: AccountChanges) => Promise<void>;
  /** Deletes the whole partition: account deletion, and the demo reset. */
  clear: () => Promise<void>;
}

export interface FileStore {
  put: (key: string, bytes: Uint8Array) => Promise<void>;
  get: (key: string) => Promise<Uint8Array | null>;
  remove: (key: string) => Promise<void>;
  /** Deletes everything the store holds. Account deletion, and the reset. */
  clear: () => Promise<void>;
}

/** Injected so a test can freeze time and name every row it expects. */
export interface CoreEnvironment {
  now: () => number;
  /** `newId("job")` in production is a ULID; a test can make it a counter. */
  newId: (prefix: string) => string;
}

/**
 * How a finished file becomes a URL the browser can follow without an
 * `Authorization` header. In the deployed system it is a presigned S3 GET
 * valid for fifteen minutes (section 7.2); locally it is the same idea with a
 * smaller signature. Returning null means "no link", which is what a deleted
 * or unfinished file gets.
 */
export interface DownloadSigner {
  fileUrl: (jobId: string, now: number) => string | null;
  zipUrl: (batchId: string, now: number) => string | null;
}

/** Nothing is downloadable: the shape a caller that serves no files can use. */
export const NO_DOWNLOADS: DownloadSigner = {
  fileUrl: () => null,
  zipUrl: () => null,
};
