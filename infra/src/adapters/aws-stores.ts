import type { AccountChanges, AccountData, FileStore, MetadataStore } from "@lexicue/core";

/**
 * Where the DynamoDB and S3 stores go, and what each call becomes.
 *
 * **Nothing here is implemented, on purpose.** There is no AWS account, so an
 * implementation could not be run against anything, and an unrunnable
 * implementation of a money path is worse than an honest gap: it would look
 * tested and would not be. What is here instead is the exact call each method
 * of the two interfaces becomes, so the work left is typing rather than
 * design, and a clear failure if anything invokes one before then.
 *
 * The shape is already settled by `packages/core`, which is the point of that
 * package: `load` is one `Query`, `commit` is one `TransactWriteItems`, and the
 * file store is three object calls. See `infra/README.md`.
 */

export class NotDeployedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not implemented: there is no AWS account yet. See infra/README.md and packages/core/src/stores.ts.`,
    );
    this.name = "NotDeployedError";
  }
}

export interface DynamoStoreOptions {
  readonly tableName: string;
  /** The Cognito `sub`, which is the partition: `USER#{sub}` (spec 7.4). */
  readonly userId: string;
}

/**
 * `MetadataStore` over the single table of specification section 7.4.
 *
 * - `load` → one `QueryCommand` with `KeyConditionExpression: PK = :pk` and
 *   `:pk = USER#{sub}`, sorted into its kinds by the `SK` prefix: `PROFILE`,
 *   `BATCH#`, `JOB#`, `LEDGER#`. One round trip, and it pages only for a user
 *   with more than a megabyte of history.
 * - `commit` → one `TransactWriteItemsCommand`. `requireBalanceAtLeast` is a
 *   `ConditionExpression` of `balanceCents >= :required` on the `PROFILE` item,
 *   which is section 7.4's conditional update; a `TransactionCanceledException`
 *   whose reason is `ConditionalCheckFailed` becomes the core's
 *   `ConcurrentWriteError`. Fifty files fit: a transaction allows 100
 *   items and the worst case is a profile, a batch, 50 jobs and a ledger entry.
 * - `clear` → a `Query` for the partition's keys and `BatchWriteItem` deletes,
 *   which is what `DELETE /api/me` needs; the `EMAIL#{hash}` marker is in a
 *   different partition and is deliberately left alone (section 6.8).
 */
export class DynamoMetadataStore implements MetadataStore {
  constructor(private readonly options: DynamoStoreOptions) {}

  load(): Promise<AccountData | null> {
    return Promise.reject(
      new NotDeployedError(`DynamoMetadataStore.load on ${this.options.tableName}`),
    );
  }

  commit(_changes: AccountChanges): Promise<void> {
    return Promise.reject(
      new NotDeployedError(`DynamoMetadataStore.commit on ${this.options.tableName}`),
    );
  }

  clear(): Promise<void> {
    return Promise.reject(
      new NotDeployedError(`DynamoMetadataStore.clear on ${this.options.tableName}`),
    );
  }
}

/**
 * `FileStore` over the bucket of section 7.2, whose keys the core already
 * produces: `uploads/{uploadId}` and `outputs/{jobId}`.
 *
 * `put` → `PutObjectCommand`, `get` → `GetObjectCommand` (a `NoSuchKey` is
 * null, not an error, because a file expired by the lifecycle rule is a normal
 * outcome), `remove` → `DeleteObjectCommand`, `clear` → a listing and
 * `DeleteObjects` under the user's prefix.
 *
 * Note what is *not* here: the presigned POST and GET. Those are signed by the
 * API handler, never by this store, because the bytes never pass through a
 * Lambda (section 7.1) and the only thing the API hands out is a URL.
 */
export class S3FileStore implements FileStore {
  constructor(private readonly bucket: string) {}

  put(_key: string, _bytes: Uint8Array): Promise<void> {
    return Promise.reject(new NotDeployedError(`S3FileStore.put on ${this.bucket}`));
  }

  get(_key: string): Promise<Uint8Array | null> {
    return Promise.reject(new NotDeployedError(`S3FileStore.get on ${this.bucket}`));
  }

  remove(_key: string): Promise<void> {
    return Promise.reject(new NotDeployedError(`S3FileStore.remove on ${this.bucket}`));
  }

  clear(): Promise<void> {
    return Promise.reject(new NotDeployedError(`S3FileStore.clear on ${this.bucket}`));
  }
}
