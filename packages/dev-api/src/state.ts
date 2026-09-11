import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Everything the local development API keeps. It stands in for the single
 * DynamoDB table of spec section 7.4 and the S3 bucket of section 7.2, so the
 * shapes follow those rows: money in integer cents, an append-only ledger, a
 * batch with its jobs, and file bytes held apart from the metadata.
 *
 * Metadata is one JSON file and the bytes are ordinary files, both under
 * `.local/`, which is git-ignored and thrown away by the demo reset. Nothing
 * here outlives a development session in any meaningful sense, but it does
 * outlive a restart of the server, which is what makes a wallet feel like a
 * wallet.
 */

export const STATE_VERSION = 1;

/** Files are deleted 24 hours after a job finishes (spec section 3.2). */
export const FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** History is kept for 30 days. */
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface DevUser {
  userId: string;
  email: string;
  emailVerified: boolean;
  createdAt: number;
}

/** One uploaded file. The bytes are on disk under `uploads/`. */
export interface DevUpload {
  uploadId: string;
  fileName: string;
  byteLength: number;
  received: boolean;
  createdAt: number;
}

export interface DevJob {
  jobId: string;
  batchId: string;
  fileName: string;
  outputFileName: string;
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
  /** Whether `outputs/{jobId}` exists; the bytes themselves are on disk. */
  hasOutput: boolean;
  outputBom: boolean;
  report: FileReport | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface DevBatch {
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
  createdAt: number;
  finishedAt: number | null;
  filesExpireAt: number | null;
  filesDeleted: boolean;
}

/** A top-up. There is no Stripe here, so confirming the page is the webhook. */
export interface DevCheckout {
  sessionId: string;
  amountCents: number;
  status: "open" | "paid";
  createdAt: number;
  credited: boolean;
}

export interface DevState extends WalletState {
  version: number;
  user: DevUser | null;
  /** The development session token, in place of a Cognito id token. */
  token: string | null;
  /** Emails that have had their one free balance (spec sections 6.5 and 6.8). */
  grantedEmails: string[];
  filesToday: number;
  filesTodayStamp: string;
  uploads: DevUpload[];
  batches: DevBatch[];
  jobs: DevJob[];
  ledger: LedgerEntry[];
  checkouts: DevCheckout[];
}

export function emptyState(): DevState {
  return {
    version: STATE_VERSION,
    user: null,
    token: null,
    balanceCents: 0,
    freeCents: 0,
    grantedEmails: [],
    filesToday: 0,
    filesTodayStamp: "",
    uploads: [],
    batches: [],
    jobs: [],
    ledger: [],
    checkouts: [],
  };
}

/** The day a file count belongs to, for the 100-files-a-day limit. */
export function dayStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The repository's `.local/dev-api`, which is git-ignored. */
export function defaultStateDir(): string {
  return fileURLToPath(new URL("../../../.local/dev-api", import.meta.url));
}

/**
 * The metadata and the file bytes, on disk. Kept deliberately dumb: a whole-file
 * write on every change is fine for one developer and one browser tab, and it
 * means the state on disk is always a complete, readable snapshot.
 */
export class DevStore {
  readonly dir: string;
  private state: DevState;

  constructor(dir: string = defaultStateDir()) {
    this.dir = dir;
    this.state = this.read();
  }

  current(): DevState {
    return this.state;
  }

  private get statePath(): string {
    return join(this.dir, "state.json");
  }

  private read(): DevState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return emptyState();
      const state = parsed as DevState;
      // State written by an older build is thrown away rather than migrated; a
      // wrong balance would be worse than a fresh start.
      return state.version === STATE_VERSION ? state : emptyState();
    } catch {
      return emptyState();
    }
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  uploadPath(uploadId: string): string {
    return join(this.dir, "uploads", uploadId);
  }

  outputPath(jobId: string): string {
    return join(this.dir, "outputs", jobId);
  }

  writeFileBytes(path: string, bytes: Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  readFileBytes(path: string): Uint8Array | null {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      return null;
    }
  }

  removeFile(path: string): void {
    rmSync(path, { force: true });
  }

  /** The demo reset: every uploaded and translated file, and the wallet. */
  reset(): void {
    rmSync(this.dir, { recursive: true, force: true });
    this.state = emptyState();
    this.save();
  }

  /** Applies the two retention rules of spec section 3.2. */
  prune(now: number): void {
    const state = this.state;
    for (const batch of state.batches) {
      if (batch.filesExpireAt !== null && batch.filesExpireAt <= now && !batch.filesDeleted) {
        this.deleteBatchFiles(batch);
      }
    }

    const staleUploads = state.uploads.filter(
      (upload) => now - upload.createdAt >= FILE_RETENTION_MS,
    );
    for (const upload of staleUploads) this.removeFile(this.uploadPath(upload.uploadId));
    state.uploads = state.uploads.filter((upload) => now - upload.createdAt < FILE_RETENTION_MS);

    const expired = new Set(
      state.batches
        .filter((batch) => now - batch.createdAt > HISTORY_RETENTION_MS)
        .map((batch) => batch.batchId),
    );
    if (expired.size > 0) {
      state.batches = state.batches.filter((batch) => !expired.has(batch.batchId));
      state.jobs = state.jobs.filter((job) => !expired.has(job.batchId));
    }
    state.ledger = state.ledger.filter(
      (entry) => now - new Date(entry.at).getTime() <= HISTORY_RETENTION_MS,
    );
  }

  /** Deletes a batch's translated files, keeping the history row (spec 7.3). */
  deleteBatchFiles(batch: DevBatch): void {
    batch.filesDeleted = true;
    for (const job of this.state.jobs) {
      if (job.batchId !== batch.batchId) continue;
      this.removeFile(this.outputPath(job.jobId));
      job.hasOutput = false;
    }
  }
}
