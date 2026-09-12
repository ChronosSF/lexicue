import { TARGET_LANGUAGES, type TranslationModelClient } from "@lexicue/harness";
import {
  DEFAULT_TOP_UP_CENTS,
  FREE_BALANCE_CENTS,
  LANES,
  MINIMUM_PRICE_CENTS,
  RATE_CENTS_PER_1000_CHARS,
  TOP_UP_AMOUNTS_CENTS,
  formatCents,
  priceCents,
} from "@lexicue/pricing";
import {
  ApiError,
  CONCURRENT_FAST_FILES,
  CreateBatchRequestSchema,
  CreateUploadsRequestSchema,
  MAX_FILES_PER_DAY,
  TopUpRequestSchema,
  applyCharge,
  applyGrant,
  applyTopUp,
  type BatchListResponse,
  type BatchResponse,
  type CreateBatchResponse,
  type CreateUploadsResponse,
  type LanguagesResponse,
  type MeResponse,
  type PricingResponse,
  type TopUpResponse,
} from "@lexicue/shared";
import {
  MAX_CUES_PER_FILE,
  MAX_FILE_BYTES,
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BYTES,
  REJECTION_MESSAGES,
} from "@lexicue/subtitles";
import {
  dayStamp,
  emptyAccount,
  jobsOfBatch,
  outputKey,
  uploadKey,
  walletView,
  type AccountData,
  type AccountRecord,
  type BatchRecord,
  type JobRecord,
  type UploadRecord,
} from "./records.js";
import { assertUploadRequestWithinLimits, filesTodayFor, intake } from "./intake.js";
import {
  bumpDailyCount,
  chargeDescription,
  deleteBatchFiles,
  failJobs,
  isEmptyChanges,
  planBatch,
  prune,
  settleBatch,
  type PlannedBatch,
} from "./lifecycle.js";
import { runUpload, type UploadOutcome } from "./worker.js";
import { toBatchSummary, toBatchView, uniqueZipEntryName, zipFileName } from "./views.js";
import type {
  AccountChanges,
  CoreEnvironment,
  DownloadSigner,
  FileStore,
  MetadataStore,
} from "./stores.js";
import { validateRequest } from "./validation.js";
import { applyChanges } from "./memory.js";

/**
 * The authoritative side of specification section 7.3, with no transport in it.
 *
 * Every method is one route: it takes what the route carries, validates it
 * against the shared contract, applies the rules, writes one commit, and
 * returns the wire shape. What it does not do is read a request, write a
 * response, sign a token or touch a socket — an HTTP server does that in
 * development and an API Gateway Lambda does it in Phase 2, and neither of them
 * gets to decide what anything costs.
 *
 * Each method loads the user's whole partition, which is one DynamoDB `Query`
 * on `USER#{sub}`, and writes at most one commit, which is one
 * `TransactWriteItems`. That is deliberate: a route that cannot be expressed
 * that way would be a route that cannot be a Lambda.
 */

export interface ApiServiceOptions {
  metadata: MetadataStore;
  files: FileStore;
  environment: CoreEnvironment;
  downloads: DownloadSigner;
  /** Cues per model request; the denominator of the progress bar (spec 4.4). */
  batchSize?: number;
  /**
   * Refuse the economy lane before anything is charged, with this sentence.
   * The local development API sets it because holding a Message Batch open for
   * up to 23 hours inside a restarting dev server is the wrong place for it.
   */
  refuseEconomy?: string;
  /** A file the caller wants to fail on purpose, for the demo's refund row. */
  shouldFail?: (fileName: string) => boolean;
  /**
   * Whether the caller starts translating in the same breath as creating the
   * batch. A queue-backed worker does not: the rows say `queued` until a
   * message is picked up, which is what section 7.5 describes. The local API
   * does, in its own process, and a row that says `queued` while a glossary
   * pass is already running is a lie the progress bar has to live with for the
   * ten seconds that pass takes — so it sets this and the 202 says `running`.
   */
  startsImmediately?: boolean;
}

/** What a caller has to do after `createBatch`: translate these files. */
export interface StartedBatch {
  response: CreateBatchResponse;
  work: PlannedBatch | null;
}

export class ApiService {
  private readonly metadata: MetadataStore;
  private readonly files: FileStore;
  private readonly environment: CoreEnvironment;
  private readonly downloads: DownloadSigner;
  private readonly batchSize: number;
  private readonly refuseEconomy: string | null;
  private readonly shouldFail: (fileName: string) => boolean;
  private readonly startsImmediately: boolean;

  constructor(options: ApiServiceOptions) {
    this.metadata = options.metadata;
    this.files = options.files;
    this.environment = options.environment;
    this.downloads = options.downloads;
    this.batchSize = options.batchSize ?? 120;
    this.refuseEconomy = options.refuseEconomy ?? null;
    this.shouldFail = options.shouldFail ?? ((): boolean => false);
    this.startsImmediately = options.startsImmediately ?? false;
  }

  // ------------------------------------------------------------------- state

  /**
   * The partition, with the retention rules of section 3.2 already applied.
   *
   * The changes are applied to the copy in hand as well as committed, so a
   * route cannot answer out of a snapshot it has just expired: without that,
   * the first request after a batch aged out would still serve the batch.
   */
  async loadPruned(now: number): Promise<AccountData> {
    const data = (await this.metadata.load()) ?? emptyAccount();
    const changes = await prune(data, this.files, now);
    if (!isEmptyChanges(changes)) {
      await this.metadata.commit(changes);
      applyChanges(data, changes);
    }
    return data;
  }

  /** For an adapter that has to answer a question the contract has no route for. */
  async load(): Promise<AccountData> {
    return (await this.metadata.load()) ?? emptyAccount();
  }

  async commit(changes: AccountChanges): Promise<void> {
    await this.metadata.commit(changes);
  }

  // ------------------------------------------------------------------- reads

  async me(now: number): Promise<MeResponse> {
    const data = await this.loadPruned(now);
    const user = requireUser(data.account);
    return {
      user: {
        userId: user.userId,
        email: user.email,
        emailVerified: user.emailVerified,
        createdAt: new Date(user.createdAt).toISOString(),
      },
      balanceCents: data.account.balanceCents,
      freeCents: data.account.freeCents,
      limits: {
        maxFilesPerUpload: MAX_FILES_PER_UPLOAD,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxFileBytes: MAX_FILE_BYTES,
        maxCuesPerFile: MAX_CUES_PER_FILE,
        concurrentFastFiles: CONCURRENT_FAST_FILES,
        maxFilesPerDay: MAX_FILES_PER_DAY,
        filesRunning: data.jobs.filter(
          (job) => job.status === "running" || job.status === "submitted",
        ).length,
        filesToday: filesTodayFor(data, now),
      },
      recentBatches: [...data.batches]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)
        .map((batch) => toBatchSummary(data, batch, this.downloads, now)),
      transactions: [...data.ledger].sort(
        (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
      ),
    };
  }

  /** Unauthenticated and cacheable at the edge (spec section 7.3). */
  pricing(): PricingResponse {
    return {
      rates: LANES.map((lane) => ({
        lane,
        centsPer1000Chars: RATE_CENTS_PER_1000_CHARS[lane],
        delivery:
          lane === "fast"
            ? "About two minutes per film"
            : "Usually within the hour, at most 24 hours",
        description:
          lane === "fast"
            ? "Files are translated three at a time and appear as they finish."
            : "The same model and the same guarantees; only the waiting differs.",
      })),
      minimumPriceCents: MINIMUM_PRICE_CENTS,
      topUpAmountsCents: [...TOP_UP_AMOUNTS_CENTS],
      defaultTopUpCents: DEFAULT_TOP_UP_CENTS,
      freeBalanceCents: FREE_BALANCE_CENTS,
      examples: [
        { label: "Sitcom episode, 22 min", dialogueChars: 16_000 },
        { label: "Drama episode, 45 min", dialogueChars: 30_000 },
        { label: "Feature film, 2 h", dialogueChars: 60_000 },
        { label: "Ten-episode drama season", dialogueChars: 300_000 },
      ].map((example) => ({
        ...example,
        fastCents: priceCents(example.dialogueChars, "fast"),
        economyCents: priceCents(example.dialogueChars, "economy"),
      })),
    };
  }

  languages(): LanguagesResponse {
    return { languages: TARGET_LANGUAGES.map((language) => ({ ...language })) };
  }

  async getBatch(batchId: string, now: number): Promise<BatchResponse> {
    const data = await this.loadPruned(now);
    return { batch: toBatchView(data, requireBatch(data, batchId), this.downloads, now) };
  }

  async listBatches(now: number): Promise<BatchListResponse> {
    const data = await this.loadPruned(now);
    return {
      batches: [...data.batches]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((batch) => toBatchSummary(data, batch, this.downloads, now)),
    };
  }

  // ----------------------------------------------------------------- uploads

  async createUploads(
    body: unknown,
    now: number,
    urlFor: (uploadId: string) => { url: string; fields: Record<string, string> },
  ): Promise<CreateUploadsResponse> {
    const data = await this.loadPruned(now);
    requireVerified(data.account);
    // The count is checked before the schema so that too many files is the
    // sentence of section 3.2 rather than a schema complaint.
    const given = (body as { files?: unknown }).files;
    if (Array.isArray(given)) {
      assertUploadRequestWithinLimits(given as { byteLength: number }[]);
    }
    const request = validateRequest(CreateUploadsRequestSchema, body);
    assertUploadRequestWithinLimits(request.files);

    const records: UploadRecord[] = [];
    const uploads = request.files.map((file) => {
      const uploadId = this.environment.newId("upl");
      records.push({
        uploadId,
        fileName: file.fileName,
        byteLength: file.byteLength,
        received: false,
        createdAt: now,
      });
      return {
        uploadId,
        fileName: file.fileName,
        ...urlFor(uploadId),
        maxBytes: MAX_FILE_BYTES,
        expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
      };
    });
    await this.metadata.commit({ putUploads: records });
    return { uploads };
  }

  /**
   * The bytes arriving. In the deployed system S3 does this and enforces the
   * size with the presigned policy's `content-length-range`, so nothing here
   * runs; the check is repeated because a local stand-in has to enforce it too.
   */
  async receiveUpload(uploadId: string, bytes: Uint8Array): Promise<void> {
    const data = await this.load();
    const upload = data.uploads.find((row) => row.uploadId === uploadId);
    if (upload === undefined) {
      throw new ApiError({ code: "not-found", message: "That upload slot has expired." });
    }
    if (bytes.length > MAX_FILE_BYTES) {
      throw new ApiError({ code: "bad-request", message: REJECTION_MESSAGES["too-large"] });
    }
    await this.files.put(uploadKey(uploadId), bytes);
    await this.metadata.commit({
      putUploads: [{ ...upload, byteLength: bytes.length, received: true }],
    });
  }

  // ----------------------------------------------------------------- batches

  /**
   * `POST /api/batches`: the one route that takes money. It parses and prices
   * every file, checks every limit, charges the wallet and creates every row in
   * one commit, and returns 202 with the work the caller must now run.
   */
  async createBatch(body: unknown, now: number): Promise<StartedBatch> {
    const data = await this.loadPruned(now);
    requireVerified(data.account);
    const request = validateRequest(CreateBatchRequestSchema, body);

    if (request.lane === "economy" && this.refuseEconomy !== null) {
      throw new ApiError({ code: "bad-request", message: this.refuseEconomy });
    }

    const priced = await intake(data, this.files, request, now);
    const batchId = this.environment.newId("bat");
    const charge = applyCharge(walletView(data), {
      totalCents: priced.totalCents,
      ref: batchId,
      description: chargeDescription(priced),
      now,
    });

    const planned = planBatch(priced, {
      batchId,
      jobId: () => this.environment.newId("job"),
      options: request.options,
      lane: request.lane,
      batchSize: this.batchSize,
      fromFree: charge.fromFree,
      now,
    });
    bumpDailyCount(data, planned.jobs.length, now);
    data.batches = [...data.batches, planned.batch];
    data.jobs = [...data.jobs, ...planned.jobs];

    // The demo's one rule, and the only reason a caller may inject a failure:
    // a file named "fail" fails on purpose and is refunded on its own, so the
    // per-file refund of section 2.3 can be seen without breaking anything.
    const doomed = planned.jobs.filter((job) => this.shouldFail(job.fileName));
    if (doomed.length > 0) {
      failJobs(
        data,
        planned.batch,
        doomed,
        "This file could not be translated, so it was refunded to your balance. Nothing else in the upload was affected.",
        now,
      );
    }

    const translatable = planned.jobs.filter((job) => job.status !== "failed");
    if (this.startsImmediately && translatable.length > 0) {
      planned.batch.status = "running";
      const first = translatable[0];
      if (first !== undefined) first.status = "running";
    }
    await this.metadata.commit({
      account: data.account,
      putBatches: [planned.batch],
      putJobs: planned.jobs,
      replaceLedger: data.ledger,
      // Section 7.4's conditional update: the charge either takes the whole
      // amount or nothing, and a balance that moved underneath it takes nothing.
      requireBalanceAtLeast: 0,
    });

    return {
      response: {
        batch: toBatchView(data, planned.batch, this.downloads, now),
        balanceCents: data.account.balanceCents,
        freeCents: data.account.freeCents,
      },
      work:
        translatable.length === 0
          ? null
          : {
              batch: planned.batch,
              jobs: translatable,
              documents: planned.documents.filter(
                (_document, index) => planned.jobs[index]?.status !== "failed",
              ),
            },
    };
  }

  /**
   * The worker of section 7.5. A Lambda behind the SQS queue calls exactly
   * this; the local API calls it in the background of the same process.
   */
  async translate(
    work: PlannedBatch,
    client: TranslationModelClient,
    config: { batchSize?: number } = {},
  ): Promise<UploadOutcome> {
    return runUpload({
      work,
      client,
      service: this,
      files: this.files,
      environment: this.environment,
      ...(config.batchSize === undefined ? {} : { batchSize: config.batchSize }),
    });
  }

  /** `DELETE /api/batches/{id}`: the files go now, the history row stays. */
  async deleteBatch(batchId: string, now: number): Promise<void> {
    const data = await this.loadPruned(now);
    const batch = requireBatch(data, batchId);
    const jobs = await deleteBatchFiles(data, this.files, batch);
    await this.metadata.commit({ putBatches: [batch], putJobs: jobs });
  }

  /**
   * What goes into a batch's zip, and what to call it. The bytes are fetched by
   * the caller because in the deployed system a separate Lambda streams them
   * straight from S3 (section 7.2) and never holds them all at once.
   */
  async zipContents(
    batchId: string,
    now: number,
  ): Promise<{ fileName: string; entries: { name: string; key: string }[] }> {
    const data = await this.loadPruned(now);
    const batch = requireBatch(data, batchId);
    const entries: { name: string; key: string }[] = [];
    const taken = new Set<string>();
    for (const job of jobsOfBatch(data, batch)) {
      if (job.status !== "done" || !job.hasOutput) continue;
      const name = uniqueZipEntryName(taken, job.outputFileName);
      taken.add(name);
      entries.push({ name, key: outputKey(job.jobId) });
    }
    return { fileName: zipFileName(batch), entries };
  }

  /** The bytes of one finished file, or null when there are none to serve. */
  async outputBytes(jobId: string): Promise<{ fileName: string; bytes: Uint8Array } | null> {
    const data = await this.load();
    const job = data.jobs.find((row) => row.jobId === jobId);
    if (job === undefined) return null;
    const bytes = await this.files.get(outputKey(job.jobId));
    return bytes === null ? null : { fileName: job.outputFileName, bytes };
  }

  // ----------------------------------------------------------------- billing

  async topUp(
    body: unknown,
    now: number,
    checkoutUrlFor: (sessionId: string, amountCents: number) => string,
  ): Promise<TopUpResponse> {
    const data = await this.loadPruned(now);
    requireVerified(data.account);
    const request = validateRequest(TopUpRequestSchema, body);
    if (!(TOP_UP_AMOUNTS_CENTS as readonly number[]).includes(request.amountCents)) {
      throw new ApiError({
        code: "bad-request",
        message: `Top-ups are ${TOP_UP_AMOUNTS_CENTS.map(formatCents).join(", ")}.`,
      });
    }
    const sessionId = this.environment.newId("cs");
    await this.metadata.commit({
      putCheckouts: [
        {
          sessionId,
          amountCents: request.amountCents,
          status: "open",
          createdAt: now,
          credited: false,
        },
      ],
    });
    return {
      checkoutUrl: checkoutUrlFor(sessionId, request.amountCents),
      sessionId,
      amountCents: request.amountCents,
    };
  }

  /**
   * What Stripe's `checkout.session.completed` webhook does (section 6.6). The
   * `credited` flag is the idempotency marker: a redelivered event finds it set
   * and credits nothing, which is the conditional put the section asks for.
   */
  async creditCheckout(sessionId: string, now: number): Promise<{ balanceCents: number }> {
    const data = await this.load();
    const checkout = data.checkouts.find((row) => row.sessionId === sessionId);
    if (checkout === undefined) {
      throw new ApiError({ code: "not-found", message: "That checkout session has expired." });
    }
    if (checkout.credited) return { balanceCents: data.account.balanceCents };

    applyTopUp(walletView(data), { amountCents: checkout.amountCents, ref: sessionId, now });
    await this.metadata.commit({
      account: data.account,
      putCheckouts: [{ ...checkout, status: "paid", credited: true }],
      replaceLedger: data.ledger,
    });
    return { balanceCents: data.account.balanceCents };
  }

  // ----------------------------------------------------------------- account

  /**
   * Verifying an email is what grants the $2.50, once per address ever
   * (sections 2.1, 6.5 and 6.8). Cognito's post-confirmation trigger calls
   * this in the deployed system.
   */
  async verifyEmail(now: number): Promise<AccountRecord> {
    const data = await this.load();
    const user = requireUser(data.account);
    user.emailVerified = true;
    if (!data.account.grantedEmails.includes(user.email)) {
      data.account.grantedEmails = [...data.account.grantedEmails, user.email];
      applyGrant(walletView(data), FREE_BALANCE_CENTS, now);
    }
    await this.metadata.commit({ account: data.account, replaceLedger: data.ledger });
    return data.account;
  }

  /**
   * `DELETE /api/me`. Everything goes except the record that this email has
   * had its free balance, which is what stops a second grant (section 6.8).
   */
  async deleteAccount(): Promise<void> {
    const granted = (await this.load()).account.grantedEmails;
    await this.metadata.clear();
    await this.files.clear();
    const fresh = emptyAccount();
    fresh.account.grantedEmails = granted;
    await this.metadata.commit({ account: fresh.account });
  }

  /** Everything, including the grant record: the demo's "reset" button only. */
  async reset(): Promise<void> {
    await this.metadata.clear();
    await this.files.clear();
  }
}

function requireUser(account: AccountRecord): NonNullable<AccountRecord["user"]> {
  const user = account.user;
  if (user === null) {
    throw new ApiError({ code: "unauthorised", message: "Sign in to continue." });
  }
  return user;
}

/** Section 2.1: a verified email before the first translation, and before a top-up. */
export function requireVerified(account: AccountRecord): void {
  if (!requireUser(account).emailVerified) {
    throw new ApiError({
      code: "email-not-verified",
      message: "Verify your email address before your first translation.",
    });
  }
}

export function requireBatch(data: AccountData, batchId: string): BatchRecord {
  const batch = data.batches.find((row) => row.batchId === batchId);
  if (batch === undefined) {
    throw new ApiError({
      code: "not-found",
      message: "That upload is no longer in your history.",
    });
  }
  return batch;
}

export { dayStamp, settleBatch };
export type { JobRecord };
