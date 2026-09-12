import { emptyAccount, type AccountData } from "./records.js";
import {
  ConcurrentWriteError,
  type AccountChanges,
  type FileStore,
  type MetadataStore,
} from "./stores.js";

/**
 * The stores in memory: the reference implementation, and what the tests use.
 *
 * `applyChanges` is the whole of what a commit means, and a DynamoDB adapter
 * has to agree with it item for item, so it is written once here and reused by
 * any adapter that can hold the partition in memory before writing it — which
 * is what the local development API's disk store does.
 */

export function applyChanges(data: AccountData, changes: AccountChanges): void {
  if (
    changes.requireBalanceAtLeast !== undefined &&
    data.account.balanceCents < changes.requireBalanceAtLeast
  ) {
    throw new ConcurrentWriteError(
      `The balance is ${data.account.balanceCents.toString()} cents and this write needs at least ${changes.requireBalanceAtLeast.toString()}.`,
    );
  }

  if (changes.account !== undefined) data.account = changes.account;

  data.uploads = merge(
    data.uploads,
    changes.putUploads,
    changes.deleteUploadIds,
    (u) => u.uploadId,
  );
  data.batches = merge(data.batches, changes.putBatches, changes.deleteBatchIds, (b) => b.batchId);
  data.jobs = merge(data.jobs, changes.putJobs, changes.deleteJobIds, (j) => j.jobId);
  data.checkouts = merge(data.checkouts, changes.putCheckouts, undefined, (c) => c.sessionId);

  if (changes.replaceLedger !== undefined) data.ledger = [...changes.replaceLedger];
  if (changes.appendLedger !== undefined) data.ledger = [...data.ledger, ...changes.appendLedger];
}

/** Puts replace by id and keep their position; deletes remove by id. */
function merge<T>(
  current: readonly T[],
  puts: readonly T[] | undefined,
  deletes: readonly string[] | undefined,
  idOf: (item: T) => string,
): T[] {
  const removed = new Set(deletes ?? []);
  const byId = new Map((puts ?? []).map((item) => [idOf(item), item]));
  const next: T[] = [];
  for (const item of current) {
    const id = idOf(item);
    if (removed.has(id)) continue;
    const replacement = byId.get(id);
    if (replacement === undefined) {
      next.push(item);
      continue;
    }
    next.push(replacement);
    byId.delete(id);
  }
  for (const item of byId.values()) {
    if (removed.has(idOf(item))) continue;
    next.push(item);
  }
  return next;
}

export class InMemoryMetadataStore implements MetadataStore {
  private data: AccountData | null;

  constructor(initial: AccountData | null = null) {
    this.data = initial;
  }

  load(): Promise<AccountData | null> {
    return Promise.resolve(this.data === null ? null : structuredClone(this.data));
  }

  commit(changes: AccountChanges): Promise<void> {
    const next = this.data === null ? emptyAccount() : structuredClone(this.data);
    applyChanges(next, changes);
    this.data = next;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.data = null;
    return Promise.resolve();
  }

  /** For assertions in tests; not part of the interface. */
  snapshot(): AccountData {
    return this.data === null ? emptyAccount() : structuredClone(this.data);
  }
}

export class InMemoryFileStore implements FileStore {
  private readonly files = new Map<string, Uint8Array>();

  put(key: string, bytes: Uint8Array): Promise<void> {
    this.files.set(key, bytes);
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(key) ?? null);
  }

  remove(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.files.clear();
    return Promise.resolve();
  }

  get size(): number {
    return this.files.size;
  }
}
