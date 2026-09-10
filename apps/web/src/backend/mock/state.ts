import type {
  BatchStatus,
  FileReport,
  JobStatus,
  Lane,
  LedgerEntry,
  SeasonGlossarySummary,
  SubtitleFormat,
  TranslationOptions,
} from "@subtitle-translator/shared";

/**
 * Everything the mock backend keeps. It is the browser's stand-in for the
 * single DynamoDB table of spec section 7.4 plus the S3 bucket of section 7.2,
 * so the shapes below follow those rows: money in integer cents, an append-only
 * ledger, a batch with its jobs, and file bytes held apart from the metadata.
 *
 * The whole thing is persisted to `localStorage`, so a reload keeps the balance,
 * the history and any file that has not yet passed its 24-hour deletion.
 */

export const STORAGE_KEY = "subtitle-translator/demo";
export const STATE_VERSION = 1;

/** One uploaded file, as base64 because `localStorage` holds strings. */
export interface StoredUpload {
  uploadId: string;
  fileName: string;
  base64: string;
  byteLength: number;
  createdAt: number;
}

export interface StoredJob {
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
  /** How much of the price came out of the free grant, so a refund can restore it. */
  freeChargedCents: number;
  refundedCents: number;
  sourceLanguage: string | null;
  batchesTotal: number;
  /**
   * The simulated schedule. Progress is a pure function of these and the clock,
   * so it survives a reload and needs no timer to be correct.
   */
  startAt: number;
  endAt: number;
  /** The plain sentence a failed file shows, or null (spec section 2.3). */
  failReason: string | null;
  /** The translated file, held until its 24 hours are up. */
  outputText: string | null;
  outputBom: boolean;
  report: FileReport | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface StoredBatch {
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
  /** When the files are deleted; the history row outlives them (spec 3.2). */
  filesExpireAt: number | null;
  filesDeleted: boolean;
}

export interface StoredCheckout {
  sessionId: string;
  amountCents: number;
  status: "open" | "paid" | "cancelled";
  createdAt: number;
  /**
   * When the balance moves. Stripe's webhook lands a moment after the redirect,
   * and the wallet screen says "Payment received, updating balance" until it
   * does (spec section 2.2), so the mock keeps that moment.
   */
  creditAt: number | null;
  credited: boolean;
}

export interface StoredUser {
  userId: string;
  email: string;
  emailVerified: boolean;
  createdAt: number;
}

export interface MockState {
  version: number;
  user: StoredUser | null;
  /** Signing out keeps the account and its wallet; it only ends the session. */
  signedIn: boolean;
  /** An account that has signed in but not yet followed the verification link. */
  pendingEmail: string | null;
  balanceCents: number;
  freeCents: number;
  /**
   * Emails that have had their one free balance. The deployed system keeps a
   * hashed email for the same reason (spec sections 6.5 and 6.8).
   */
  grantedEmails: string[];
  filesToday: number;
  filesTodayStamp: string;
  uploads: StoredUpload[];
  batches: StoredBatch[];
  jobs: StoredJob[];
  ledger: LedgerEntry[];
  checkouts: StoredCheckout[];
}

/** How long the simulation takes. Tests shrink these to nothing. */
export interface MockTiming {
  /** Fixed part of a file's wall time on the fast lane. */
  fastBaseMs: number;
  /** Added per character of dialogue, so a film takes longer than an episode. */
  fastPerCharMs: number;
  fastMaxMs: number;
  /** Files translating at once on the fast lane (spec section 3.2). */
  fastConcurrency: number;
  /** How long an economy-lane Message Batch takes to come back. */
  economyMs: number;
  /** What the SPA is told to wait before polling again. */
  pollFastMs: number;
  pollEconomyMs: number;
  /** A short pause before the balance moves, so the wallet screen can poll. */
  checkoutSettleMs: number;
}

export const DEFAULT_TIMING: MockTiming = {
  fastBaseMs: 2_500,
  fastPerCharMs: 0.9,
  fastMaxMs: 14_000,
  fastConcurrency: 3,
  economyMs: 12_000,
  pollFastMs: 700,
  pollEconomyMs: 1_500,
  checkoutSettleMs: 900,
};

/** Files are deleted 24 hours after a job finishes (spec section 3.2). */
export const FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** History is kept for 30 days. */
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function emptyState(): MockState {
  return {
    version: STATE_VERSION,
    user: null,
    signedIn: false,
    pendingEmail: null,
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

export function loadState(storage: Storage): MockState | null {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const state = parsed as MockState;
    // A state written by an older build is thrown away rather than migrated;
    // it is a demo, and a wrong balance would be worse than a fresh start.
    return state.version === STATE_VERSION ? state : null;
  } catch {
    return null;
  }
}

/**
 * Writes the state back, dropping what the product would already have deleted.
 * If the browser refuses the write because the quota is full, the translated
 * files go first: they are the only large thing here and the only thing the
 * product promises to delete anyway.
 */
export function saveState(storage: Storage, state: MockState, now: number): void {
  prune(state, now);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return;
  } catch {
    for (const job of state.jobs) {
      job.outputText = null;
    }
    for (const upload of state.uploads) {
      upload.base64 = "";
    }
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // A demo that cannot persist still works for the length of the session.
    }
  }
}

/** Applies the two retention rules of spec section 3.2. */
export function prune(state: MockState, now: number): void {
  for (const batch of state.batches) {
    if (batch.filesExpireAt !== null && batch.filesExpireAt <= now) batch.filesDeleted = true;
  }
  const deleted = new Set(
    state.batches.filter((batch) => batch.filesDeleted).map((batch) => batch.batchId),
  );
  for (const job of state.jobs) {
    if (deleted.has(job.batchId)) job.outputText = null;
  }

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

/** Ids that read like the ULIDs the deployed system uses. */
export function newId(prefix: string): string {
  const random = globalThis.crypto.getRandomValues(new Uint8Array(8));
  const suffix = Array.from(random, (byte) => byte.toString(36).padStart(2, "0")).join("");
  return `${prefix}_${suffix.slice(0, 12)}`;
}
