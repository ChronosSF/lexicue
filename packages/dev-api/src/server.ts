import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TARGET_LANGUAGES, findTargetLanguage } from "@lexicue/harness";
import type { TranslationModelClient } from "@lexicue/harness";
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
  STATUS_FOR_ERROR,
  TopUpRequestSchema,
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
  type CreateBatchResponse,
  type CreateUploadsResponse,
  type LanguagesResponse,
  type MeResponse,
  type PricingResponse,
  type TopUpResponse,
  type UnusableFile,
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
import { parseSubtitleBytes } from "@lexicue/subtitles/encoding";
import { zipSync } from "fflate";
import {
  DevStore,
  dayStamp,
  emptyState,
  type DevBatch,
  type DevJob,
  type DevState,
} from "./state.js";
import { batchesFor, createRunner, outputFileName, runningTimeMs } from "./translate.js";
import type { HarnessConfig } from "@lexicue/harness";
import { DownloadLinks, jobsOf, toBatchSummary, toBatchView, zipFileName } from "./views.js";

/**
 * The routes of spec section 7.3, on plain `node:http`, for one developer on
 * one machine. Everything the contract describes is implemented for real —
 * files are parsed and priced with the same packages the browser previews them
 * with, the wallet is charged before any work starts, and the translation is
 * the real harness against whatever model client is supplied.
 *
 * Three things are development-only and live under `/api/dev`, never `/api`:
 * a sign-in that stands in for Cognito, a checkout that credits the balance
 * because there is no Stripe webhook to do it, and the file downloads, which
 * stand in for presigned S3 GETs. They are only reachable because this server
 * is only ever started by `pnpm dev`; nothing deployed runs this file.
 */

/** A file named like this fails on purpose, as it does in the mock backend. */
const FAILURE_FILE_PATTERN = /fail/i;

export interface DevApiOptions {
  /** The model client the harness runs against. */
  client: TranslationModelClient;
  /** Where state and files live; defaults to `.local/dev-api`. */
  stateDir?: string;
  config?: Partial<HarnessConfig>;
  now?: () => number;
  /** Set false in tests that want to assert on a finished batch synchronously. */
  runInBackground?: boolean;
}

export interface DevApi {
  readonly store: DevStore;
  handle: (request: IncomingMessage, response: ServerResponse) => void;
  /**
   * Defaults to `localhost` rather than `127.0.0.1` so that the port is taken
   * on whichever stack Vite probes when it looks for a free one. Binding only
   * IPv4 left Vite free to take the same port number on IPv6, and the two then
   * sat on "the same port" talking past each other.
   */
  listen: (port: number, host?: string) => Promise<Server>;
  /** Resolves once every translation this server started has settled. */
  idle: () => Promise<void>;
}

export function createDevApi(options: DevApiOptions): DevApi {
  const store = new DevStore(options.stateDir);
  const clock = options.now ?? ((): number => Date.now());
  const links = new DownloadLinks(randomBytes(32));
  const runner = createRunner({
    store,
    client: options.client,
    ...(options.config === undefined ? {} : { config: options.config }),
    now: clock,
  });
  const runInBackground = options.runInBackground ?? true;
  let pending: Promise<void> = Promise.resolve();

  const api: DevApi = {
    store,
    handle(request, response) {
      void route(request, response).catch((error: unknown) => {
        send(response, error instanceof ApiError ? error : internal(error));
      });
    },
    listen(port, host = "localhost") {
      const server = createServer((request, response) => {
        api.handle(request, response);
      });
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          resolve(server);
        });
      });
    },
    idle: () => pending,
  };

  return api;

  // ------------------------------------------------------------------ routing

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = request.method ?? "GET";
    const now = clock();
    store.prune(now);

    const batchId = matchPath(path, "/api/batches/");
    const uploadId = matchPath(path, "/api/dev/uploads/");
    const checkoutId = matchPath(path, "/api/dev/checkout/");
    const fileId = matchPath(path, "/api/dev/files/");

    const handler = pick();
    if (handler === null) {
      throw new ApiError({ code: "not-found", message: `No route for ${method} ${path}.` });
    }
    await handler();

    function pick(): (() => void | Promise<void>) | null {
      // Unauthenticated, and the development-only routes.
      if (method === "GET" && path === "/api/pricing")
        return () => {
          json(response, 200, pricing());
        };
      if (method === "GET" && path === "/api/languages") {
        return () => {
          json(response, 200, languages());
        };
      }
      if (method === "POST" && path === "/api/dev/session") {
        return () => devSignIn(request, response, now);
      }
      if (method === "POST" && path === "/api/dev/verify") {
        return () => {
          devVerify(request, response, now);
        };
      }
      if (method === "POST" && path === "/api/dev/reset")
        return () => {
          devReset(response);
        };
      if (method === "GET" && fileId !== null)
        return () => {
          download(url, fileId, response, now);
        };

      // The contract of spec section 7.3.
      if (method === "GET" && path === "/api/me")
        return () => {
          me(request, response, now);
        };
      if (method === "DELETE" && path === "/api/me")
        return () => {
          deleteAccount(request, response);
        };
      if (method === "POST" && path === "/api/uploads") {
        return () => createUploads(request, response, now);
      }
      if (method === "POST" && uploadId !== null) {
        return () => putUpload(request, response, uploadId);
      }
      if (method === "POST" && path === "/api/batches") {
        return () => createBatch(request, response, now);
      }
      if (method === "GET" && path === "/api/batches") {
        return () => {
          listBatches(request, response, now);
        };
      }
      if (method === "GET" && batchId !== null) {
        return () => {
          getBatch(request, response, batchId, now);
        };
      }
      if (method === "DELETE" && batchId !== null) {
        return () => {
          deleteBatch(request, response, batchId);
        };
      }
      if (method === "POST" && path === "/api/billing/topup") {
        return () => topUp(request, response, now);
      }
      if (method === "POST" && checkoutId !== null) {
        return () => {
          completeCheckout(request, response, checkoutId, now);
        };
      }
      return null;
    }
  }

  // ------------------------------------------------------------- development

  /**
   * Development sign-in, in place of Cognito. Any address is accepted and there
   * is no password, exactly as in the mock backend; the token it returns is
   * shaped like a JWT only so the browser can read its own claims out of it the
   * way it will read Cognito's.
   */
  async function devSignIn(
    request: IncomingMessage,
    response: ServerResponse,
    now: number,
  ): Promise<void> {
    const body = await readJson(request);
    const given = (body as { email?: unknown }).email;
    const email = typeof given === "string" ? given.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError({
        code: "bad-request",
        message: "That does not look like an email address.",
      });
    }

    const state = store.current();
    if (state.user?.email !== email) {
      // Signing in as somebody else starts that account from nothing, which is
      // how the one-free-balance rule can be demonstrated.
      const granted = state.grantedEmails;
      const fresh = emptyState();
      fresh.grantedEmails = granted;
      Object.assign(state, fresh);
      state.user = { userId: newId("usr"), email, emailVerified: false, createdAt: now };
    }
    const user = state.user;
    if (user === null) throw new ApiError({ code: "internal", message: "No account." });
    state.token = devToken(user.userId, user.email, user.emailVerified);
    store.save();
    json(response, 200, { token: state.token });
  }

  /** Following the verification link is what grants the $2.50 (spec 2.1). */
  function devVerify(request: IncomingMessage, response: ServerResponse, now: number): void {
    const state = requireSession(request);
    const user = state.user;
    if (user === null)
      throw new ApiError({ code: "unauthorised", message: "Sign in to continue." });
    user.emailVerified = true;
    if (!state.grantedEmails.includes(user.email)) {
      state.grantedEmails.push(user.email);
      applyGrant(state, FREE_BALANCE_CENTS, now);
    }
    state.token = devToken(user.userId, user.email, true);
    store.save();
    json(response, 200, { token: state.token });
  }

  function devReset(response: ServerResponse): void {
    store.reset();
    json(response, 200, { ok: true });
  }

  // ------------------------------------------------------------------- reads

  function me(request: IncomingMessage, response: ServerResponse, now: number): void {
    const state = requireSession(request);
    const user = requireUser(state);
    json(response, 200, {
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
        concurrentFastFiles: CONCURRENT_FAST_FILES,
        maxFilesPerDay: MAX_FILES_PER_DAY,
        filesRunning: state.jobs.filter(
          (job) => job.status === "running" || job.status === "submitted",
        ).length,
        filesToday: state.filesTodayStamp === dayStamp(now) ? state.filesToday : 0,
      },
      recentBatches: [...state.batches]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)
        .map((batch) => toBatchSummary(state, batch, links, now)),
      transactions: [...state.ledger].sort(
        (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
      ),
    } satisfies MeResponse);
  }

  function pricing(): PricingResponse {
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

  function languages(): LanguagesResponse {
    return { languages: TARGET_LANGUAGES.map((language) => ({ ...language })) };
  }

  // ----------------------------------------------------------------- uploads

  async function createUploads(
    request: IncomingMessage,
    response: ServerResponse,
    now: number,
  ): Promise<void> {
    const state = requireSession(request);
    requireVerified(state);
    // The count is checked before the schema so that too many files is the
    // sentence of spec section 3.2 rather than a schema complaint.
    const raw = await readJson(request);
    const given = (raw as { files?: unknown }).files;
    if (Array.isArray(given) && given.length > MAX_FILES_PER_UPLOAD) {
      throw new ApiError({
        code: "limit-exceeded",
        message: `An upload can carry ${MAX_FILES_PER_UPLOAD.toString()} files at a time. Split the rest into a second upload.`,
        limit: "files-per-upload",
      });
    }
    const body = validate(CreateUploadsRequestSchema, raw);
    const total = body.files.reduce((sum, file) => sum + file.byteLength, 0);
    if (total > MAX_UPLOAD_BYTES) {
      throw new ApiError({
        code: "limit-exceeded",
        message: `An upload can carry ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toString()} MB in total. Split the rest into a second upload.`,
        limit: "upload-bytes",
      });
    }

    const uploads = body.files.map((file) => {
      const uploadId = newId("upl");
      state.uploads.push({
        uploadId,
        fileName: file.fileName,
        byteLength: file.byteLength,
        received: false,
        createdAt: now,
      });
      return {
        uploadId,
        fileName: file.fileName,
        // A presigned S3 POST in the deployed system; the route below here.
        url: `/api/dev/uploads/${uploadId}`,
        fields: { key: `uploads/${uploadId}` },
        maxBytes: MAX_FILE_BYTES,
        expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
      };
    });
    store.save();
    json(response, 200, { uploads } satisfies CreateUploadsResponse);
  }

  /**
   * The presigned POST itself. The browser sends the same `multipart/form-data`
   * body S3 would be given, so the client code that does it is the code Phase 2
   * keeps; Node's own `Request` parses it.
   */
  async function putUpload(
    request: IncomingMessage,
    response: ServerResponse,
    uploadId: string,
  ): Promise<void> {
    const state = store.current();
    const upload = state.uploads.find((row) => row.uploadId === uploadId);
    if (upload === undefined) {
      throw new ApiError({ code: "not-found", message: "That upload slot has expired." });
    }

    const body = await readBody(request, MAX_FILE_BYTES + 64 * 1024);
    const contentType = request.headers["content-type"] ?? "";
    let bytes: Uint8Array;
    if (contentType.includes("multipart/form-data")) {
      const parsed = new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      // undici steers servers at a streaming parser for large bodies. This one
      // is capped at 5 MB by spec section 3.2, serves one developer, and needs
      // no new dependency; in the deployed system S3 parses this body and none
      // of this code exists.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
      const form = await parsed.formData();
      const file = form.get("file");
      if (typeof file === "string" || file === null) {
        throw new ApiError({ code: "bad-request", message: "That upload carried no file." });
      }
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      bytes = new Uint8Array(body);
    }

    if (bytes.length > MAX_FILE_BYTES) {
      throw new ApiError({ code: "bad-request", message: REJECTION_MESSAGES["too-large"] });
    }
    store.writeFileBytes(store.uploadPath(uploadId), bytes);
    upload.byteLength = bytes.length;
    upload.received = true;
    store.save();
    json(response, 204, null);
  }

  // ----------------------------------------------------------------- batches

  async function createBatch(
    request: IncomingMessage,
    response: ServerResponse,
    now: number,
  ): Promise<void> {
    const state = requireSession(request);
    requireVerified(state);
    const body = validate(CreateBatchRequestSchema, await readJson(request));

    if (body.lane === "economy") {
      // Wiring the economy lane here would mean holding a Message Batch open
      // for up to 23 hours inside a development server that restarts whenever a
      // file changes, and the only way to find out whether it works is to spend
      // an hour of real waiting and real money. Refusing it plainly is better
      // than half-wiring it (see apps/web/README.md).
      throw new ApiError({
        code: "bad-request",
        message:
          "The economy lane is not available in local development: it hands the work to the Message Batches API, which can take up to 24 hours to come back. Pick the fast lane.",
      });
    }

    const target = findTargetLanguage(body.targetLanguage);
    if (target === undefined) {
      throw new ApiError({
        code: "bad-request",
        message: "That target language is not on the list.",
      });
    }

    const uploads = body.uploadIds.map((uploadId) => {
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

    // Parse every file server-side, exactly as the browser preview did, so the
    // price the user confirmed is the price computed here (spec section 6.1).
    const names = uploads.map((upload) => upload.fileName);
    const parsed: { fileName: string; document: SubtitleDocument }[] = [];
    const unusable: UnusableFile[] = [];
    for (const upload of uploads) {
      try {
        if (hasImageCompanion(upload.fileName, names)) {
          throw new SubtitleRejectedError("image-based", upload.fileName);
        }
        const bytes = store.readFileBytes(store.uploadPath(upload.uploadId));
        if (bytes === null) throw new SubtitleRejectedError("empty", upload.fileName);
        parsed.push({
          fileName: upload.fileName,
          document: parseSubtitleBytes(bytes, { fileName: upload.fileName }),
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

    const first = parsed[0];
    if (first !== undefined) {
      const guess = guessSourceLanguage(first.document);
      if (targetIsSource(target.code, guess)) {
        const name = TARGET_LANGUAGES.find((l) => l.code === guess.code)?.name ?? guess.code ?? "";
        throw new ApiError({
          code: "target-is-source-language",
          message: `These files already look like ${name}. Pick a different target language.`,
          sourceLanguage: name,
        });
      }
    }

    const filesToday = state.filesTodayStamp === dayStamp(now) ? state.filesToday : 0;
    if (filesToday + parsed.length > MAX_FILES_PER_DAY) {
      throw new ApiError({
        code: "limit-exceeded",
        message: `You have translated ${filesToday.toString()} files today, and the daily limit is ${MAX_FILES_PER_DAY.toString()}. The rest can go through tomorrow.`,
        limit: "files-per-day",
      });
    }

    const prices = parsed.map((file) => priceCents(file.document.dialogueChars, body.lane));
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
          ? `Translated ${first?.fileName ?? "one file"} into ${target.name}`
          : `Translated ${parsed.length.toString()} files into ${target.name}`,
      now,
    });

    let freeLeft = charge.fromFree;
    const batchSize = runnerBatchSize();
    const jobs: DevJob[] = parsed.map((file, index) => {
      const price = prices[index] ?? 0;
      const freeShare = Math.min(freeLeft, price);
      freeLeft -= freeShare;
      return {
        jobId: newId("job"),
        batchId,
        fileName: file.fileName,
        outputFileName: outputFileName(file.fileName, target.code),
        status: "queued",
        lane: body.lane,
        format: file.document.format,
        encoding: file.document.encoding,
        cueCount: file.document.cues.length,
        dialogueChars: file.document.dialogueChars,
        runningTimeMs: runningTimeMs(file.document),
        priceCents: price,
        freeChargedCents: freeShare,
        refundedCents: 0,
        sourceLanguage: null,
        batchesTotal: batchesFor(file.document.cues.length, batchSize),
        batchesDone: 0,
        error: null,
        hasOutput: false,
        outputBom: body.options.outputBom,
        report: null,
        createdAt: now,
        finishedAt: null,
      };
    });

    const batch: DevBatch = {
      batchId,
      status: "queued",
      lane: body.lane,
      targetLanguage: target.code,
      targetLanguageName: target.name,
      options: body.options,
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
    store.save();

    // The demo's one rule, as in the mock: a file named "fail" fails on
    // purpose and is refunded on its own, without touching the rest.
    failOnPurpose(batch, jobs, now);

    // 202: the work starts now and the client polls `GET /api/batches/{id}`.
    const translatable = jobs.filter((job) => job.status !== "failed");
    const started = runner.run({
      batch,
      jobs: translatable,
      documents: parsed
        .filter((_file, index) => jobs[index]?.status !== "failed")
        .map((file) => file.document),
      allJobs: jobs,
      target,
      options: body.options,
    });
    pending = pending.then(() => started);
    if (!runInBackground) await started;

    json(response, 202, {
      batch: toBatchView(state, batch, links, clock()),
      balanceCents: state.balanceCents,
      freeCents: state.freeCents,
    } satisfies CreateBatchResponse);
  }

  function getBatch(
    request: IncomingMessage,
    response: ServerResponse,
    batchId: string,
    now: number,
  ): void {
    const state = requireSession(request);
    json(response, 200, {
      batch: toBatchView(state, findBatch(state, batchId), links, now),
    } satisfies BatchResponse);
  }

  function listBatches(request: IncomingMessage, response: ServerResponse, now: number): void {
    const state = requireSession(request);
    json(response, 200, {
      batches: [...state.batches]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((batch) => toBatchSummary(state, batch, links, now)),
    } satisfies BatchListResponse);
  }

  function deleteBatch(request: IncomingMessage, response: ServerResponse, batchId: string): void {
    const state = requireSession(request);
    store.deleteBatchFiles(findBatch(state, batchId));
    store.save();
    json(response, 204, null);
  }

  // ----------------------------------------------------------------- billing

  async function topUp(
    request: IncomingMessage,
    response: ServerResponse,
    now: number,
  ): Promise<void> {
    const state = requireSession(request);
    requireVerified(state);
    const body = validate(TopUpRequestSchema, await readJson(request));
    if (!(TOP_UP_AMOUNTS_CENTS as readonly number[]).includes(body.amountCents)) {
      throw new ApiError({
        code: "bad-request",
        message: `Top-ups are ${TOP_UP_AMOUNTS_CENTS.map(formatCents).join(", ")}.`,
      });
    }
    const sessionId = newId("cs");
    state.checkouts.push({
      sessionId,
      amountCents: body.amountCents,
      status: "open",
      createdAt: now,
      credited: false,
    });
    store.save();
    json(response, 200, {
      // Stripe's hosted page in the deployed system; the demo's own checkout
      // screen here, which is a route inside the app.
      checkoutUrl: `#/checkout/${sessionId}/${body.amountCents.toString()}`,
      sessionId,
      amountCents: body.amountCents,
    } satisfies TopUpResponse);
  }

  /** What Stripe's `checkout.session.completed` webhook does (spec section 6.6). */
  function completeCheckout(
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string,
    now: number,
  ): void {
    const state = requireSession(request);
    const checkout = state.checkouts.find((row) => row.sessionId === sessionId);
    if (checkout === undefined) {
      throw new ApiError({ code: "not-found", message: "That checkout session has expired." });
    }
    if (!checkout.credited) {
      checkout.status = "paid";
      checkout.credited = true;
      applyTopUp(state, { amountCents: checkout.amountCents, ref: sessionId, now });
      store.save();
    }
    json(response, 200, { balanceCents: state.balanceCents });
  }

  function deleteAccount(request: IncomingMessage, response: ServerResponse): void {
    const granted = requireSession(request).grantedEmails;
    store.reset();
    // The hashed email survives account deletion so a second free balance
    // cannot be had by signing up again (spec section 6.8).
    store.current().grantedEmails = granted;
    store.save();
    json(response, 204, null);
  }

  // --------------------------------------------------------------- downloads

  function download(url: URL, id: string, response: ServerResponse, now: number): void {
    const state = store.current();
    const expires = url.searchParams.get("expires");
    const signature = url.searchParams.get("signature");
    const isZip = id.endsWith("/zip");
    const key = isZip ? `${id.slice(0, -"/zip".length)}:zip` : id;

    if (!links.verify(key, expires, signature, now)) {
      throw new ApiError({
        code: "not-found",
        message: "That download link has expired. Reload the page for a fresh one.",
      });
    }

    if (isZip) {
      const batch = findBatch(state, id.slice(0, -"/zip".length));
      const entries: Record<string, Uint8Array> = {};
      for (const job of jobsOf(state, batch)) {
        if (job.status !== "done" || !job.hasOutput) continue;
        const bytes = store.readFileBytes(store.outputPath(job.jobId));
        if (bytes === null) continue;
        entries[uniqueName(entries, job.outputFileName)] = bytes;
      }
      sendBytes(response, zipSync(entries, { level: 6 }), "application/zip", zipFileName(batch));
      return;
    }

    const job = state.jobs.find((row) => row.jobId === id);
    const bytes = job === undefined ? null : store.readFileBytes(store.outputPath(job.jobId));
    if (job === undefined || bytes === null) {
      throw new ApiError({ code: "not-found", message: "That file is no longer available." });
    }
    sendBytes(response, bytes, "text/plain; charset=utf-8", job.outputFileName);
  }

  // --------------------------------------------------------------- internals

  function runnerBatchSize(): number {
    return options.config?.batchSize ?? 120;
  }

  /** The mock's one demo rule: a file named "fail" fails, to show the refund. */
  function failOnPurpose(batch: DevBatch, jobs: readonly DevJob[], now: number): void {
    const state = store.current();
    for (const job of jobs) {
      if (!FAILURE_FILE_PATTERN.test(job.fileName)) continue;
      job.status = "failed";
      job.error =
        "This file could not be translated, so it was refunded to your balance. Nothing else in the upload was affected.";
      job.refundedCents = job.priceCents;
      job.finishedAt = now;
      batch.refundedCents += job.priceCents;
      applyRefund(state, {
        amountCents: job.priceCents,
        freeCents: job.freeChargedCents,
        ref: job.jobId,
        description: `Refund for ${job.fileName}`,
        now,
      });
    }
    store.save();
  }

  function requireSession(request: IncomingMessage): DevState {
    const state = store.current();
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (state.token === null || token !== state.token) {
      throw new ApiError({ code: "unauthorised", message: "Sign in to continue." });
    }
    return state;
  }

  function requireUser(state: DevState): NonNullable<DevState["user"]> {
    const user = state.user;
    if (user === null)
      throw new ApiError({ code: "unauthorised", message: "Sign in to continue." });
    return user;
  }

  function requireVerified(state: DevState): void {
    if (!requireUser(state).emailVerified) {
      throw new ApiError({
        code: "email-not-verified",
        message: "Verify your email address before your first translation.",
      });
    }
  }

  function findBatch(state: DevState, batchId: string): DevBatch {
    const batch = state.batches.find((row) => row.batchId === batchId);
    if (batch === undefined) {
      throw new ApiError({
        code: "not-found",
        message: "That upload is no longer in your history.",
      });
    }
    return batch;
  }
}

// ------------------------------------------------------------------ helpers

function matchPath(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  return rest === "" ? null : rest;
}

/**
 * A token shaped like a JWT, so the browser reads its claims exactly as it will
 * read Cognito's. It is not signed and proves nothing: the server accepts it
 * only because it is the string it just issued, and no deployed code path can
 * reach this file.
 */
function devToken(sub: string, email: string, emailVerified: boolean): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, email, email_verified: emailVerified, iss: "lexicue-dev-api" }),
    "utf8",
  ).toString("base64url");
  return `dev.${payload}.${randomBytes(12).toString("base64url")}`;
}

function uniqueName(entries: Record<string, Uint8Array>, name: string): string {
  if (!(name in entries)) return name;
  const dot = name.lastIndexOf(".");
  for (let attempt = 2; ; attempt += 1) {
    const candidate =
      dot <= 0
        ? `${name} (${attempt.toString()})`
        : `${name.slice(0, dot)} (${attempt.toString()})${name.slice(dot)}`;
    if (!(candidate in entries)) return candidate;
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      throw new ApiError({ code: "bad-request", message: REJECTION_MESSAGES["too-large"] });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * A request body that does not match the contract's schema is the client's
 * mistake, so it is a 400 with the schema's own complaint, never a 500.
 */
function validate<T>(schema: { parse: (input: unknown) => T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    throw new ApiError({
      code: "bad-request",
      message: `That request did not match the API contract. ${
        error instanceof Error ? error.message : ""
      }`.trim(),
    });
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, 1024 * 1024);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new ApiError({ code: "bad-request", message: "That request was not valid JSON." });
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (status === 204 || body === null) {
    response.writeHead(204);
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text).toString(),
  });
  response.end(text);
}

function sendBytes(
  response: ServerResponse,
  bytes: Uint8Array,
  contentType: string,
  fileName: string,
): void {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": bytes.length.toString(),
    // Spec section 8: output files and zips are served as attachments.
    "content-disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
  });
  response.end(Buffer.from(bytes));
}

function send(response: ServerResponse, error: ApiError): void {
  json(response, STATUS_FOR_ERROR[error.body.code], { error: error.body });
}

function internal(error: unknown): ApiError {
  process.stderr.write(
    `[dev-api] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  return new ApiError({
    code: "internal",
    message: "Something went wrong on our side. Nothing has been charged; try again in a moment.",
  });
}
