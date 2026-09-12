import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ApiService, emptyAccount, type PlannedBatch } from "@lexicue/core";
import type { HarnessConfig, TranslationModelClient } from "@lexicue/harness";
import { ApiError, STATUS_FOR_ERROR, newId } from "@lexicue/shared";
import { MAX_FILE_BYTES, REJECTION_MESSAGES } from "@lexicue/subtitles";
import { zipSync } from "fflate";
import { DownloadLinks } from "./links.js";
import { DevStore, type DevSnapshot } from "./store.js";

/**
 * The routes of spec section 7.3 on plain `node:http`, for one developer on
 * one machine.
 *
 * This file is an adapter and nothing else. It reads a request, checks the
 * development session token, hands the body to `@lexicue/core`, and writes
 * whatever the core returns as JSON. Every decision that matters — what a file
 * is, what it costs, whether the balance covers it, what state an upload is in —
 * is the core's, which is the same code a Lambda handler will call in Phase 2.
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
  readonly service: ApiService;
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

/** Why the economy lane is refused here rather than half-wired. */
const ECONOMY_REFUSAL =
  "The economy lane is not available in local development: it hands the work to the Message Batches API, which can take up to 24 hours to come back. Pick the fast lane.";

export function createDevApi(options: DevApiOptions): DevApi {
  const store = new DevStore(options.stateDir);
  const clock = options.now ?? ((): number => Date.now());
  const links = new DownloadLinks(randomBytes(32));
  const batchSize = options.config?.batchSize ?? 120;
  const service = new ApiService({
    metadata: store.metadata,
    files: store.files,
    downloads: links,
    environment: { now: clock, newId: newId },
    batchSize,
    refuseEconomy: ECONOMY_REFUSAL,
    shouldFail: (fileName) => FAILURE_FILE_PATTERN.test(fileName),
    // This server translates in its own process, starting before it answers.
    startsImmediately: true,
  });
  const runInBackground = options.runInBackground ?? true;
  let pending: Promise<void> = Promise.resolve();

  const api: DevApi = {
    store,
    service,
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

    const batchId = matchPath(path, "/api/batches/");
    const uploadId = matchPath(path, "/api/dev/uploads/");
    const checkoutId = matchPath(path, "/api/dev/checkout/");
    const fileId = matchPath(path, "/api/dev/files/");

    // Unauthenticated, and the development-only routes.
    if (method === "GET" && path === "/api/pricing") {
      json(response, 200, service.pricing());
      return;
    }
    if (method === "GET" && path === "/api/languages") {
      json(response, 200, service.languages());
      return;
    }
    if (method === "POST" && path === "/api/dev/session") return devSignIn(request, response, now);
    if (method === "POST" && path === "/api/dev/verify") return devVerify(request, response, now);
    if (method === "POST" && path === "/api/dev/reset") {
      store.reset();
      json(response, 200, { ok: true });
      return;
    }
    if (method === "GET" && fileId !== null) return download(url, fileId, response, now);

    // The contract of spec section 7.3.
    if (method === "GET" && path === "/api/me") {
      await requireSession(request);
      json(response, 200, await service.me(now));
      return;
    }
    if (method === "DELETE" && path === "/api/me") {
      await requireSession(request);
      await service.deleteAccount();
      json(response, 204, null);
      return;
    }
    if (method === "POST" && path === "/api/uploads") {
      await requireSession(request);
      json(
        response,
        200,
        await service.createUploads(await readJson(request), now, (id) => ({
          // A presigned S3 POST in the deployed system; the route below here.
          url: `/api/dev/uploads/${id}`,
          fields: { key: `uploads/${id}` },
        })),
      );
      return;
    }
    if (method === "POST" && uploadId !== null) return putUpload(request, response, uploadId);
    if (method === "POST" && path === "/api/batches") return createBatch(request, response, now);
    if (method === "GET" && path === "/api/batches") {
      await requireSession(request);
      json(response, 200, await service.listBatches(now));
      return;
    }
    if (method === "GET" && batchId !== null) {
      await requireSession(request);
      json(response, 200, await service.getBatch(batchId, now));
      return;
    }
    if (method === "DELETE" && batchId !== null) {
      await requireSession(request);
      await service.deleteBatch(batchId, now);
      json(response, 204, null);
      return;
    }
    if (method === "POST" && path === "/api/billing/topup") {
      await requireSession(request);
      json(
        response,
        200,
        await service.topUp(
          await readJson(request),
          now,
          // Stripe's hosted page in the deployed system; the demo's own
          // checkout screen here, which is a route inside the app.
          (sessionId, amountCents) => `#/checkout/${sessionId}/${amountCents.toString()}`,
        ),
      );
      return;
    }
    if (method === "POST" && checkoutId !== null) {
      await requireSession(request);
      json(response, 200, await service.creditCheckout(checkoutId, now));
      return;
    }

    throw new ApiError({ code: "not-found", message: `No route for ${method} ${path}.` });
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

    const data = await service.load();
    if (data.account.user?.email !== email) {
      // Signing in as somebody else starts that account from nothing, which is
      // how the one-free-balance rule can be demonstrated.
      const granted = data.account.grantedEmails;
      await service.reset();
      const fresh = emptyAccount();
      fresh.account.grantedEmails = granted;
      fresh.account.user = {
        userId: newId("usr"),
        email,
        emailVerified: false,
        createdAt: now,
      };
      fresh.account.authToken = devToken(fresh.account.user.userId, email, false);
      await service.commit({ account: fresh.account });
      json(response, 200, { token: fresh.account.authToken });
      return;
    }

    const user = data.account.user;
    data.account.authToken = devToken(user.userId, user.email, user.emailVerified);
    await service.commit({ account: data.account });
    json(response, 200, { token: data.account.authToken });
  }

  /** Following the verification link is what grants the $2.50 (spec 2.1). */
  async function devVerify(
    request: IncomingMessage,
    response: ServerResponse,
    now: number,
  ): Promise<void> {
    await requireSession(request);
    const account = await service.verifyEmail(now);
    const user = account.user;
    if (user === null) throw new ApiError({ code: "internal", message: "No account." });
    account.authToken = devToken(user.userId, user.email, true);
    await service.commit({ account });
    json(response, 200, { token: account.authToken });
  }

  // ----------------------------------------------------------------- uploads

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
    await service.receiveUpload(uploadId, bytes);
    json(response, 204, null);
  }

  // ----------------------------------------------------------------- batches

  async function createBatch(
    request: IncomingMessage,
    response: ServerResponse,
    now: number,
  ): Promise<void> {
    await requireSession(request);
    const started = await service.createBatch(await readJson(request), now);
    // 202: the work starts now and the client polls `GET /api/batches/{id}`.
    const work: PlannedBatch | null = started.work;
    if (work !== null) {
      const running = service
        .translate(work, options.client, { batchSize })
        .then(() => undefined)
        .catch((error: unknown) => {
          process.stderr.write(`[dev-api] ${String(error)}\n`);
        });
      pending = pending.then(() => running);
      if (!runInBackground) await running;
    }
    json(response, 202, started.response);
  }

  // --------------------------------------------------------------- downloads

  async function download(
    url: URL,
    id: string,
    response: ServerResponse,
    now: number,
  ): Promise<void> {
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
      const zip = await service.zipContents(id.slice(0, -"/zip".length), now);
      const entries: Record<string, Uint8Array> = {};
      for (const entry of zip.entries) {
        const bytes = await store.files.get(entry.key);
        if (bytes !== null) entries[entry.name] = bytes;
      }
      sendBytes(response, zipSync(entries, { level: 6 }), "application/zip", zip.fileName);
      return;
    }

    const output = await service.outputBytes(id);
    if (output === null) {
      throw new ApiError({ code: "not-found", message: "That file is no longer available." });
    }
    sendBytes(response, output.bytes, "text/plain; charset=utf-8", output.fileName);
  }

  // --------------------------------------------------------------- internals

  /**
   * The only authentication this file does. In the deployed system the API
   * Gateway JWT authorizer validates a Cognito token before any handler runs,
   * so nothing like this exists there; here the token is accepted because it is
   * the string this server just issued.
   */
  async function requireSession(request: IncomingMessage): Promise<DevSnapshot> {
    const data = await service.load();
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (data.account.authToken === null || token !== data.account.authToken) {
      throw new ApiError({ code: "unauthorised", message: "Sign in to continue." });
    }
    return store.current();
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
