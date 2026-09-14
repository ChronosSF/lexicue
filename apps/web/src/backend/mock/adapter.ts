import { TARGET_LANGUAGES, findTargetLanguage } from "@lexicue/harness";
import {
  DEFAULT_RATE_TABLE,
  DEFAULT_TOP_UP_CENTS,
  FREE_BALANCE_CENTS,
  LANES,
  TOP_UP_AMOUNTS_CENTS,
  formatCents,
  meteredOf,
  priceCents,
  type RateTable,
} from "@lexicue/pricing";
import {
  ApiError,
  MAX_FILES_PER_DAY,
  applyCharge,
  applyGrant,
  applyRefund,
  applyTopUp,
  guessSourceLanguage,
  insufficientBalance,
  newId,
  targetIsSource,
  type BatchListResponse,
  type BatchResponse,
  type CreateBatchRequest,
  type CreateBatchResponse,
  type CreateUploadsRequest,
  type CreateUploadsResponse,
  type LanguagesResponse,
  type MeResponse,
  type PricingResponse,
  type TopUpRequest,
  type TopUpResponse,
  type UnusableFile,
  type UploadTarget,
} from "@lexicue/shared";
import {
  MAX_CUES_PER_FILE,
  MAX_FILE_BYTES,
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BYTES,
  REJECTION_MESSAGES,
  SubtitleRejectedError,
  hasImageCompanion,
  type SubtitleDocument,
} from "@lexicue/subtitles";
import { parseSubtitleBytesInBrowser } from "@lexicue/subtitles/browser";
import type { BackendAdapter, DemoControls, SampleFile, Session } from "../types.js";
import { DownloadUrls, base64ToBytes, bytesToBase64, type UrlFactory } from "./bytes.js";
import { seedDemoState } from "./seed.js";
import {
  DEFAULT_TIMING,
  FILE_RETENTION_MS,
  STORAGE_KEY,
  dayStamp,
  emptyState,
  loadState,
  saveState,
  type MockState,
  type MockTiming,
  type StoredBatch,
  type StoredJob,
} from "./state.js";
import {
  documentText,
  harnessOptions,
  outputFileName,
  runFakeTranslation,
  runningTimeMs,
} from "./translate.js";
import { batchesFor, jobsOf, toBatchSummary, toBatchView } from "./views.js";

/**
 * The whole product, in the browser, with no server at all.
 *
 * It implements the contract of spec section 7.3 against in-memory state that
 * is persisted to `localStorage`: files are parsed with `packages/subtitles`
 * and priced with `packages/pricing`, exactly as the real preview will be;
 * batches are charged with the wallet rules of section 7.4; and the translation
 * itself is the real harness driven by its deterministic fake model client, so
 * a downloaded file is structurally intact.
 *
 * Two things here are simulation rather than implementation, and both are
 * marked where they happen: the passage of time (a file's progress is a pure
 * function of the clock, and the economy lane comes back in seconds instead of
 * an hour) and the checkout, which credits the balance itself because there is
 * no Stripe webhook to do it.
 */

/** A file named like this fails on purpose, to show the refund of section 2.3. */
const FAILURE_FILE_PATTERN = /fail/i;

const FAILURE_MESSAGE =
  "This file could not be translated, so it was refunded to your balance. Nothing else in the upload was affected.";

export interface MockBackendOptions {
  storage?: Storage;
  now?: () => number;
  timing?: Partial<MockTiming>;
  /** Loads the sample manifest; defaults to fetching it from `/samples`. */
  loadSampleList?: () => Promise<SampleFile[]>;
  /** Loads one sample file's bytes. */
  loadSample?: (path: string) => Promise<Uint8Array>;
  /** Set false to start empty, which is what most tests want. */
  seedDemo?: boolean;
  /** How a finished file becomes a URL; only tests need to replace it. */
  createDownloadUrl?: UrlFactory;
  /** What each lane charges; defaults to today's published prices. */
  rates?: RateTable;
}

export class MockBackend implements BackendAdapter {
  readonly kind = "mock";

  private readonly storage: Storage;
  private readonly clock: () => number;
  /**
   * Only the seed moves this: it backdates the clock so the demo's history and
   * ledger look like a few days of use rather than a burst at first paint.
   */
  private clockOffset = 0;
  private readonly timing: MockTiming;
  private readonly urls: DownloadUrls;
  private readonly loadSampleList: () => Promise<SampleFile[]>;
  private readonly loadSampleBytes: (path: string) => Promise<Uint8Array>;
  private readonly wantsSeed: boolean;
  private readonly rates: RateTable;
  private state: MockState | null = null;
  private seeding: Promise<void> | null = null;

  constructor(options: MockBackendOptions = {}) {
    this.storage = options.storage ?? window.localStorage;
    this.clock = options.now ?? (() => Date.now());
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.wantsSeed = options.seedDemo ?? true;
    this.urls =
      options.createDownloadUrl === undefined
        ? new DownloadUrls()
        : new DownloadUrls(options.createDownloadUrl);
    this.loadSampleList = options.loadSampleList ?? defaultSampleList;
    this.loadSampleBytes = options.loadSample ?? defaultSampleBytes;
    this.rates = options.rates ?? DEFAULT_RATE_TABLE;
  }

  // ---------------------------------------------------------------- session

  async getSession(): Promise<Session | null> {
    const state = await this.ready();
    if (state.user === null || !state.signedIn) return null;
    return {
      userId: state.user.userId,
      email: state.user.email,
      emailVerified: state.user.emailVerified,
    };
  }

  /**
   * Any email is accepted; there is no password, because there is no Cognito.
   * Signing in as somebody else starts that person's account from nothing,
   * which is how the free-balance rule below can be demonstrated.
   */
  async signIn(input: { email: string }): Promise<Session> {
    const state = await this.ready();
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError({
        code: "bad-request",
        message: "That does not look like an email address.",
      });
    }

    if (state.user?.email !== email) {
      const fresh = emptyState();
      fresh.grantedEmails = state.grantedEmails;
      this.state = fresh;
      fresh.user = {
        userId: newId("usr"),
        email,
        emailVerified: false,
        createdAt: this.now(),
      };
      fresh.signedIn = true;
      this.persist();
      return { userId: fresh.user.userId, email, emailVerified: false };
    }

    state.signedIn = true;
    this.persist();
    return {
      userId: state.user.userId,
      email: state.user.email,
      emailVerified: state.user.emailVerified,
    };
  }

  /** Following the link in the verification email is what grants the $2.50. */
  async verifyEmail(): Promise<Session> {
    const state = await this.ready();
    const user = this.requireUser();
    user.emailVerified = true;
    if (!state.grantedEmails.includes(user.email)) {
      state.grantedEmails.push(user.email);
      applyGrant(state, FREE_BALANCE_CENTS, this.now());
    }
    this.persist();
    return { userId: user.userId, email: user.email, emailVerified: true };
  }

  async signOut(): Promise<void> {
    const state = await this.ready();
    state.signedIn = false;
    this.persist();
  }

  // ------------------------------------------------------------------- read

  async getMe(): Promise<MeResponse> {
    const state = await this.ready();
    const user = this.requireUser();
    const now = this.now();

    return {
      user: {
        userId: user.userId,
        email: user.email,
        emailVerified: user.emailVerified,
        createdAt: new Date(user.createdAt).toISOString(),
      },
      balanceCents: state.balanceCents,
      freeCents: state.freeCents,
      limits: {
        maxFilesPerUpload: MAX_FILES_PER_UPLOAD,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxFileBytes: MAX_FILE_BYTES,
        maxCuesPerFile: MAX_CUES_PER_FILE,
        concurrentFastFiles: this.timing.fastConcurrency,
        maxFilesPerDay: MAX_FILES_PER_DAY,
        filesRunning: state.jobs.filter(
          (job) => job.status === "running" || job.status === "submitted",
        ).length,
        filesToday: state.filesTodayStamp === dayStamp(now) ? state.filesToday : 0,
      },
      recentBatches: [...state.batches]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)
        .map((batch) => toBatchSummary(state, batch, now, this.timing, this.urls)),
      transactions: [...state.ledger].sort(
        (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
      ),
    };
  }

  getPricing(): Promise<PricingResponse> {
    return Promise.resolve({
      rates: LANES.map((lane) => ({
        lane,
        ...this.rates[lane],
        delivery:
          lane === "fast"
            ? "About two minutes per film"
            : "Usually within the hour, at most 24 hours",
        description:
          lane === "fast"
            ? "Files are translated three at a time and appear as they finish."
            : "The same model and the same guarantees; only the waiting differs.",
      })),
      topUpAmountsCents: [...TOP_UP_AMOUNTS_CENTS],
      defaultTopUpCents: DEFAULT_TOP_UP_CENTS,
      freeBalanceCents: FREE_BALANCE_CENTS,
      // The worked examples of spec section 6.1, with the cue counts section
      // 5.3 gives the same files, priced by the same function that prices a
      // real file rather than copied from the table.
      examples: [
        { label: "Sitcom episode, 22 min", dialogueChars: 16_000, cueCount: 350 },
        { label: "Drama episode, 45 min", dialogueChars: 30_000, cueCount: 650 },
        { label: "Feature film, 2 h", dialogueChars: 60_000, cueCount: 1_400 },
        { label: "Ten-episode drama season", dialogueChars: 300_000, cueCount: 6_500 },
      ].map((example) => ({
        ...example,
        fastCents: priceCents(example, "fast", this.rates),
        economyCents: priceCents(example, "economy", this.rates),
      })),
    });
  }

  getLanguages(): Promise<LanguagesResponse> {
    return Promise.resolve({ languages: TARGET_LANGUAGES.map((language) => ({ ...language })) });
  }

  // ---------------------------------------------------------------- uploads

  async createUploads(request: CreateUploadsRequest): Promise<CreateUploadsResponse> {
    const state = await this.ready();
    this.requireVerified();
    const now = this.now();

    if (request.files.length > MAX_FILES_PER_UPLOAD) {
      throw new ApiError({
        code: "limit-exceeded",
        message: `An upload can carry ${MAX_FILES_PER_UPLOAD.toString()} files at a time. Split the rest into a second upload.`,
        limit: "files-per-upload",
      });
    }
    const total = request.files.reduce((sum, file) => sum + file.byteLength, 0);
    if (total > MAX_UPLOAD_BYTES) {
      throw new ApiError({
        code: "limit-exceeded",
        message: `An upload can carry ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toString()} MB in total. Split the rest into a second upload.`,
        limit: "upload-bytes",
      });
    }

    const uploads: UploadTarget[] = request.files.map((file) => {
      const uploadId = newId("upl");
      state.uploads.push({
        uploadId,
        fileName: file.fileName,
        base64: "",
        byteLength: file.byteLength,
        createdAt: now,
      });
      return {
        uploadId,
        fileName: file.fileName,
        // The deployed system returns a presigned S3 POST here; the mock's
        // object store is this same state, so the URL is a marker.
        url: `mock://uploads/${uploadId}`,
        fields: { key: `uploads/${uploadId}`, "content-type": "text/plain" },
        maxBytes: MAX_FILE_BYTES,
        expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
      };
    });

    this.persist();
    return { uploads };
  }

  async putUpload(target: UploadTarget, bytes: Uint8Array): Promise<void> {
    const state = await this.ready();
    const upload = state.uploads.find((row) => row.uploadId === target.uploadId);
    if (upload === undefined) {
      throw new ApiError({ code: "not-found", message: "That upload slot has expired." });
    }
    if (bytes.length > target.maxBytes) {
      throw new ApiError({ code: "bad-request", message: REJECTION_MESSAGES["too-large"] });
    }
    upload.base64 = bytesToBase64(bytes);
    upload.byteLength = bytes.length;
    this.persist();
  }

  // ---------------------------------------------------------------- batches

  async createBatch(request: CreateBatchRequest): Promise<CreateBatchResponse> {
    const state = await this.ready();
    this.requireVerified();
    const now = this.now();

    const target = findTargetLanguage(request.targetLanguage);
    if (target === undefined) {
      throw new ApiError({
        code: "bad-request",
        message: "That target language is not on the list.",
      });
    }

    const uploads = request.uploadIds.map((uploadId) => {
      const upload = state.uploads.find((row) => row.uploadId === uploadId);
      if (upload === undefined) {
        throw new ApiError({
          code: "not-found",
          message:
            "One of these files has expired. Uploaded files are kept for 24 hours; add it again.",
        });
      }
      return upload;
    });

    // Parse every file exactly as the browser preview did, so the price the
    // user confirmed is the price computed here (spec section 6.1).
    const names = uploads.map((upload) => upload.fileName);
    const parsed: { uploadId: string; fileName: string; document: SubtitleDocument }[] = [];
    const unusable: UnusableFile[] = [];
    for (const upload of uploads) {
      try {
        if (hasImageCompanion(upload.fileName, names)) {
          throw new SubtitleRejectedError("image-based", upload.fileName);
        }
        parsed.push({
          uploadId: upload.uploadId,
          fileName: upload.fileName,
          document: parseSubtitleBytesInBrowser(base64ToBytes(upload.base64), {
            fileName: upload.fileName,
          }),
        });
      } catch (error) {
        unusable.push({
          uploadId: upload.uploadId,
          fileName: upload.fileName,
          reason: error instanceof SubtitleRejectedError ? error.code : "unreadable",
          message:
            error instanceof SubtitleRejectedError
              ? error.message
              : "This file could not be read as a subtitle file.",
        });
      }
    }
    if (unusable.length > 0) {
      throw new ApiError({
        code: "unusable-files",
        message: "Some of these files cannot be translated.",
        files: unusable,
      });
    }

    const guess = guessSourceLanguage(parsed[0]?.document ?? emptyDocument());
    if (targetIsSource(target.code, guess)) {
      throw new ApiError({
        code: "target-is-source-language",
        message: `These files already look like ${languageName(guess.code)}. Pick a different target language.`,
        sourceLanguage: languageName(guess.code),
      });
    }

    const filesToday = state.filesTodayStamp === dayStamp(now) ? state.filesToday : 0;
    if (filesToday + parsed.length > MAX_FILES_PER_DAY) {
      throw new ApiError({
        code: "limit-exceeded",
        message: `You have translated ${filesToday.toString()} files today, and the daily limit is ${MAX_FILES_PER_DAY.toString()}. The rest can go through tomorrow.`,
        limit: "files-per-day",
      });
    }

    const prices = parsed.map((file) =>
      priceCents(meteredOf(file.document), request.lane, this.rates),
    );
    const totalCents = prices.reduce((sum, price) => sum + price, 0);
    if (state.balanceCents < totalCents) {
      throw insufficientBalance(totalCents, state.balanceCents, TOP_UP_AMOUNTS_CENTS);
    }

    const batchId = newId("bat");
    const charge = applyCharge(state, {
      totalCents,
      ref: batchId,
      description:
        parsed.length === 1
          ? `Translated ${parsed[0]?.fileName ?? "one file"} into ${target.name}`
          : `Translated ${parsed.length.toString()} files into ${target.name}`,
      now,
    });

    // The free portion is spent before paid balance, and each file records the
    // share of it that it used, so a refund can put the free money back.
    let freeLeft = charge.fromFree;
    const jobs: StoredJob[] = parsed.map((file, index) => {
      const price = prices[index] ?? 0;
      const freeShare = Math.min(freeLeft, price);
      freeLeft -= freeShare;
      return {
        jobId: newId("job"),
        batchId,
        fileName: file.fileName,
        outputFileName: outputFileName(file.fileName, target.code),
        status: "queued",
        lane: request.lane,
        format: file.document.format,
        encoding: file.document.encoding,
        cueCount: file.document.cues.length,
        dialogueChars: file.document.dialogueChars,
        runningTimeMs: runningTimeMs(file.document),
        priceCents: price,
        freeChargedCents: freeShare,
        refundedCents: 0,
        sourceLanguage: null,
        batchesTotal: batchesFor(file.document.cues.length),
        startAt: now,
        endAt: now,
        failReason: FAILURE_FILE_PATTERN.test(file.fileName) ? FAILURE_MESSAGE : null,
        outputText: null,
        outputBom: request.options.outputBom,
        report: null,
        createdAt: now,
        finishedAt: null,
      };
    });

    this.schedule(jobs, now, request.lane);

    const batch: StoredBatch = {
      batchId,
      status: request.lane === "economy" ? "submitted" : "running",
      lane: request.lane,
      targetLanguage: target.code,
      targetLanguageName: target.name,
      options: request.options,
      priceCents: totalCents,
      refundedCents: 0,
      jobIds: jobs.map((job) => job.jobId),
      seasonGlossary: null,
      createdAt: now,
      finishedAt: null,
      filesExpireAt: null,
      filesDeleted: false,
    };

    state.jobs.push(...jobs);
    state.batches.push(batch);
    state.filesToday = filesToday + parsed.length;
    state.filesTodayStamp = dayStamp(now);

    // The translation itself runs now, in full, through the harness; what the
    // schedule above simulates is only how long it would have taken.
    const translatable = parsed.filter(
      (_file, index) => (jobs[index]?.failReason ?? null) === null,
    );
    const translatableJobs = jobs.filter((job) => job.failReason === null);
    if (translatable.length > 0) {
      const result = await runFakeTranslation({
        jobs: translatable.map((file, index) => ({
          jobId: translatableJobs[index]?.jobId ?? file.uploadId,
          fileName: file.fileName,
          document: file.document,
        })),
        options: harnessOptions(request.options, target, request.lane),
      });
      batch.seasonGlossary = result.seasonGlossary;
      for (const [index, file] of result.files.entries()) {
        const job = translatableJobs[index];
        if (job === undefined) continue;
        job.outputText = documentText(file.document);
        job.report = file.report;
        job.sourceLanguage = file.glossary.sourceLanguage;
      }
    }

    this.persist();
    this.settle();

    return {
      batch: toBatchView(state, batch, this.now(), this.timing, this.urls),
      balanceCents: state.balanceCents,
      freeCents: state.freeCents,
    };
  }

  async getBatch(batchId: string): Promise<BatchResponse> {
    const state = await this.ready();
    this.settle();
    const batch = state.batches.find((row) => row.batchId === batchId);
    if (batch === undefined) {
      throw new ApiError({
        code: "not-found",
        message: "That upload is no longer in your history.",
      });
    }
    return { batch: toBatchView(state, batch, this.now(), this.timing, this.urls) };
  }

  async listBatches(): Promise<BatchListResponse> {
    const state = await this.ready();
    this.settle();
    const now = this.now();
    return {
      batches: [...state.batches]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((batch) => toBatchSummary(state, batch, now, this.timing, this.urls)),
    };
  }

  async deleteBatch(batchId: string): Promise<void> {
    const state = await this.ready();
    const batch = state.batches.find((row) => row.batchId === batchId);
    if (batch === undefined) {
      throw new ApiError({
        code: "not-found",
        message: "That upload is no longer in your history.",
      });
    }
    batch.filesDeleted = true;
    for (const job of jobsOf(state, batch)) {
      job.outputText = null;
      this.urls.forget(job.jobId);
    }
    this.urls.forget(`${batch.batchId}:zip`);
    this.persist();
  }

  // ---------------------------------------------------------------- billing

  async createTopUp(request: TopUpRequest): Promise<TopUpResponse> {
    const state = await this.ready();
    this.requireVerified();
    if (!(TOP_UP_AMOUNTS_CENTS as readonly number[]).includes(request.amountCents)) {
      throw new ApiError({
        code: "bad-request",
        message: `Top-ups are ${TOP_UP_AMOUNTS_CENTS.map(formatCents).join(", ")}.`,
      });
    }
    const sessionId = newId("cs");
    state.checkouts.push({
      sessionId,
      amountCents: request.amountCents,
      status: "open",
      createdAt: this.now(),
      creditAt: null,
      credited: false,
    });
    this.persist();
    return {
      // Stripe's hosted page in the deployed system; the demo's own checkout
      // screen here, which is a route inside this app.
      checkoutUrl: `#/checkout/${sessionId}/${request.amountCents.toString()}`,
      sessionId,
      amountCents: request.amountCents,
    };
  }

  /** What Stripe's `checkout.session.completed` webhook does (spec section 6.6). */
  async completeCheckout(sessionId: string): Promise<void> {
    const state = await this.ready();
    const checkout = state.checkouts.find((row) => row.sessionId === sessionId);
    if (checkout === undefined) {
      throw new ApiError({ code: "not-found", message: "That checkout session has expired." });
    }
    if (checkout.status === "paid") return;
    checkout.status = "paid";
    // The webhook lands a moment after the redirect; until it does, the wallet
    // says "Payment received, updating balance" and keeps polling.
    checkout.creditAt = this.now() + this.timing.checkoutSettleMs;
    this.persist();
  }

  async deleteAccount(): Promise<void> {
    const state = await this.ready();
    const granted = state.grantedEmails;
    this.urls.clear();
    const fresh = emptyState();
    // The hashed email survives account deletion so a second free balance
    // cannot be had by deleting and signing up again (spec section 6.8).
    fresh.grantedEmails = granted;
    this.state = fresh;
    this.persist();
  }

  readonly demo: DemoControls = {
    listSamples: () => this.loadSampleList(),
    loadSample: async (path: string) => {
      const bytes = await this.loadSampleBytes(path);
      return { fileName: path.split("/").pop() ?? path, bytes };
    },
    reset: async () => {
      this.urls.clear();
      this.storage.removeItem(STORAGE_KEY);
      this.state = null;
      this.seeding = null;
      await this.ready();
    },
  };

  // ------------------------------------------------------------- internals

  /** Loads or seeds the state, once. */
  private async ready(): Promise<MockState> {
    if (this.state !== null) {
      this.settle();
      return this.state;
    }
    const stored = loadState(this.storage);
    if (stored !== null) {
      this.state = stored;
      this.settle();
      return stored;
    }
    this.seeding ??= this.seed();
    await this.seeding;
    this.state ??= emptyState();
    return this.state;
  }

  private async seed(): Promise<void> {
    const state = emptyState();
    this.state = state;
    if (!this.wantsSeed) {
      this.persist();
      return;
    }
    await seedDemoState(this, state, {
      now: () => this.now(),
      loadSample: (path) => this.loadSampleBytes(path),
    });
    this.persist();
  }

  private now(): number {
    return this.clock() + this.clockOffset;
  }

  /** Used by the seed only; see {@link clockOffset}. */
  setClockOffset(ms: number): void {
    this.clockOffset = ms;
  }

  private persist(): void {
    if (this.state === null) return;
    saveState(this.storage, this.state, this.now());
  }

  private requireUser(): NonNullable<MockState["user"]> {
    const user = this.state?.user ?? null;
    if (user === null || this.state?.signedIn !== true) {
      throw new ApiError({ code: "unauthorised", message: "Sign in to continue." });
    }
    return user;
  }

  private requireVerified(): void {
    const user = this.requireUser();
    if (!user.emailVerified) {
      throw new ApiError({
        code: "email-not-verified",
        message: "Verify your email address before your first translation.",
      });
    }
  }

  /**
   * Hands each file a start and an end. On the fast lane three files run at
   * once and the rest queue in order (spec section 3.2); on the economy lane
   * every file goes into one Message Batch and they come back together.
   */
  private schedule(jobs: StoredJob[], now: number, lane: "fast" | "economy"): void {
    if (lane === "economy") {
      for (const [index, job] of jobs.entries()) {
        job.startAt = now;
        job.endAt = now + this.timing.economyMs + index * 250;
      }
      return;
    }
    const slots = new Array<number>(Math.max(1, this.timing.fastConcurrency)).fill(now);
    for (const job of jobs) {
      let slot = 0;
      for (let index = 1; index < slots.length; index += 1) {
        if ((slots[index] ?? 0) < (slots[slot] ?? 0)) slot = index;
      }
      const startAt = slots[slot] ?? now;
      job.startAt = startAt;
      job.endAt = startAt + this.durationFor(job);
      slots[slot] = job.endAt;
    }
  }

  private durationFor(job: StoredJob): number {
    const modelled = this.timing.fastBaseMs + job.dialogueChars * this.timing.fastPerCharMs;
    return Math.min(this.timing.fastMaxMs, Math.round(modelled));
  }

  /**
   * Moves everything the clock has passed: files start, files finish, failures
   * are refunded, batches close, and a paid checkout credits the balance. It is
   * called on every read, which is what makes progress survive a reload.
   */
  private settle(): void {
    const state = this.state;
    if (state === null) return;
    const now = this.now();
    let changed = false;

    for (const checkout of state.checkouts) {
      if (checkout.status !== "paid" || checkout.credited) continue;
      if (checkout.creditAt !== null && checkout.creditAt > now) continue;
      applyTopUp(state, {
        amountCents: checkout.amountCents,
        ref: checkout.sessionId,
        // The ledger records when the payment was confirmed, not when this read
        // happened to notice it; a webhook lands seconds after the checkout.
        now: checkout.creditAt ?? now,
      });
      checkout.credited = true;
      changed = true;
    }

    for (const batch of state.batches) {
      if (batch.finishedAt !== null) continue;
      const jobs = jobsOf(state, batch);

      for (const job of jobs) {
        if (job.status === "done" || job.status === "failed") continue;

        if (now >= job.endAt) {
          if (job.failReason !== null) {
            job.status = "failed";
            job.refundedCents = job.priceCents;
            batch.refundedCents += job.priceCents;
            applyRefund(state, {
              amountCents: job.priceCents,
              freeCents: job.freeChargedCents,
              ref: job.jobId,
              description: `Refund for ${job.fileName}`,
              now,
            });
          } else {
            job.status = "done";
            if (job.report !== null) {
              // The report's wall time is the simulated one, not the fake
              // model's microseconds.
              job.report = { ...job.report, wallTimeMs: job.endAt - job.startAt };
            }
          }
          job.finishedAt = job.endAt;
          changed = true;
          continue;
        }

        const next =
          now >= job.startAt ? (job.lane === "economy" ? "submitted" : "running") : "queued";
        if (job.status !== next) {
          job.status = next;
          changed = true;
        }
      }

      const settledJobs = jobs.filter((job) => job.status === "done" || job.status === "failed");
      if (settledJobs.length === jobs.length && jobs.length > 0) {
        const failed = jobs.filter((job) => job.status === "failed").length;
        batch.status = failed === 0 ? "done" : failed === jobs.length ? "failed" : "partial";
        batch.finishedAt = Math.max(...jobs.map((job) => job.finishedAt ?? now));
        batch.filesExpireAt = batch.finishedAt + FILE_RETENTION_MS;
        changed = true;
      } else if (jobs.some((job) => job.status === "running")) {
        batch.status = "running";
      }
    }

    if (changed) saveState(this.storage, state, now);
  }
}

function emptyDocument(): SubtitleDocument {
  return {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "\n",
    header: "",
    cues: [],
    trailingNewline: true,
    dialogueChars: 0,
    warnings: [],
  };
}

function languageName(code: string | null): string {
  if (code === null) return "the same language";
  return TARGET_LANGUAGES.find((language) => language.code === code)?.name ?? code;
}

async function defaultSampleList(): Promise<SampleFile[]> {
  const response = await fetch("/samples/samples.json");
  if (!response.ok) throw new Error("The sample list could not be loaded.");
  return (await response.json()) as SampleFile[];
}

async function defaultSampleBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(`/samples/${path}`);
  if (!response.ok) throw new Error(`The sample ${path} could not be loaded.`);
  return new Uint8Array(await response.arrayBuffer());
}
