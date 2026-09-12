import { ApiService, type DownloadSigner, type FileStore, type MetadataStore } from "@lexicue/core";
import { ApiError, STATUS_FOR_ERROR, newId } from "@lexicue/shared";

/**
 * The API Lambda of specification section 7.2: the routes of section 7.3
 * behind the API Gateway HTTP API's JWT authorizer.
 *
 * It is a thin adapter, and thin is the point. The authorizer has already
 * validated the Cognito token before this runs, so the user id is read from the
 * claims rather than checked; the body is handed to `@lexicue/core`, which owns
 * every rule; and whatever the core returns is serialised. That is the same
 * thing `packages/dev-api` does over `node:http`, which is why the two cannot
 * disagree about what a file costs.
 *
 * The stores are constructed per invocation from the environment because they
 * are scoped to one user's partition. Nothing here is deployed yet: the stores
 * this handler is given in production are the unimplemented ones in
 * `../adapters/aws-stores.ts`, and `routeRequest` below is what the tests drive
 * with in-memory ones instead.
 */

/**
 * The fields of an API Gateway HTTP API v2 proxy event this handler reads.
 * Mirrors `APIGatewayProxyEventV2WithJWTAuthorizer` from `@types/aws-lambda`,
 * written out rather than depended on: five fields, and no dependency that
 * exists only to describe them.
 */
export interface ProxyEvent {
  rawPath: string;
  rawQueryString?: string;
  requestContext: {
    http: { method: string };
    authorizer?: { jwt?: { claims?: Record<string, string | number | boolean> } };
  };
  body?: string | null;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string | undefined> | null;
}

export interface ProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

export interface ApiDependencies {
  metadata: MetadataStore;
  files: FileStore;
  downloads: DownloadSigner;
  now?: () => number;
  batchSize?: number;
}

/** The claims the authorizer puts on the event (spec sections 7.2 and 8). */
export interface Caller {
  userId: string;
  email: string;
  emailVerified: boolean;
}

export function callerOf(event: ProxyEvent): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const sub = claims["sub"];
  if (typeof sub !== "string" || sub === "") {
    // Unreachable behind the authorizer, which is exactly why it is an error
    // rather than a guess: a route that lost its authorizer must fail closed.
    throw new ApiError({ code: "unauthorised", message: "Sign in to continue." });
  }
  return {
    userId: sub,
    email: typeof claims["email"] === "string" ? claims["email"] : "",
    emailVerified: claims["email_verified"] === true || claims["email_verified"] === "true",
  };
}

/**
 * The whole of the routing, separated from the Lambda entry point so a test can
 * drive it with in-memory stores and a hand-written event.
 */
export async function routeRequest(
  event: ProxyEvent,
  dependencies: ApiDependencies,
): Promise<ProxyResult> {
  const service = new ApiService({
    metadata: dependencies.metadata,
    files: dependencies.files,
    downloads: dependencies.downloads,
    environment: { now: dependencies.now ?? ((): number => Date.now()), newId },
    ...(dependencies.batchSize === undefined ? {} : { batchSize: dependencies.batchSize }),
    // A queue-backed worker picks the message up; the row stays `queued` until
    // it does (spec section 7.5).
    startsImmediately: false,
  });

  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const now = (dependencies.now ?? ((): number => Date.now()))();

  try {
    if (method === "GET" && path === "/api/pricing") return ok(service.pricing());
    if (method === "GET" && path === "/api/languages") return ok(service.languages());

    // Everything below is behind the authorizer.
    callerOf(event);

    if (method === "GET" && path === "/api/me") return ok(await service.me(now));
    if (method === "GET" && path === "/api/batches") return ok(await service.listBatches(now));
    if (method === "POST" && path === "/api/batches") {
      const started = await service.createBatch(bodyOf(event), now);
      // The message per file of section 7.5 is sent by the caller of this
      // module; see `enqueueOf` in the Worker stack's notes.
      return ok(started.response, 202);
    }
    if (method === "POST" && path === "/api/uploads") {
      return ok(
        await service.createUploads(bodyOf(event), now, (uploadId) => ({
          // A presigned S3 POST with a `content-length-range` condition
          // (section 3.2). Signing needs the bucket and the SDK, so it is the
          // one part of this handler the deployed build has to finish.
          url: presignedUploadUrl(uploadId),
          fields: { key: `uploads/${uploadId}` },
        })),
      );
    }
    if (method === "POST" && path === "/api/billing/topup") {
      return ok(await service.topUp(bodyOf(event), now, (sessionId) => checkoutUrl(sessionId)));
    }
    const batchId = event.pathParameters?.["id"] ?? suffixOf(path, "/api/batches/");
    if (batchId !== null && batchId !== undefined && batchId !== "") {
      if (method === "GET") return ok(await service.getBatch(batchId, now));
      if (method === "DELETE") {
        await service.deleteBatch(batchId, now);
        return { statusCode: 204, headers: {}, body: "" };
      }
    }
    if (method === "DELETE" && path === "/api/me") {
      await service.deleteAccount();
      return { statusCode: 204, headers: {}, body: "" };
    }

    throw new ApiError({ code: "not-found", message: `No route for ${method} ${path}.` });
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        statusCode: STATUS_FOR_ERROR[error.body.code],
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: error.body }),
      };
    }
    // Section 2.3: the user gets a sentence, the log gets the truth.
    console.error(error);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: {
          code: "internal",
          message:
            "Something went wrong on our side. Nothing has been charged; try again in a moment.",
        },
      }),
    };
  }
}

function ok(body: unknown, statusCode = 200): ProxyResult {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function bodyOf(event: ProxyEvent): unknown {
  const raw = event.body ?? "";
  if (raw === "") return {};
  const text = event.isBase64Encoded === true ? Buffer.from(raw, "base64").toString("utf8") : raw;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError({ code: "bad-request", message: "That request was not valid JSON." });
  }
}

function suffixOf(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  return rest === "" ? null : rest;
}

/** Signed with the SDK once the bucket exists; see aws-stores.ts. */
function presignedUploadUrl(uploadId: string): string {
  const bucket = process.env["LEXICUE_FILES_BUCKET"] ?? "";
  return `s3://${bucket}/uploads/${uploadId}`;
}

/** Stripe's hosted Checkout page (spec section 6.6), wired in Phase 3. */
function checkoutUrl(sessionId: string): string {
  return `https://checkout.stripe.com/c/pay/${sessionId}`;
}

/**
 * The Lambda entry point. The stores it builds are the unimplemented AWS ones,
 * so this throws a `NotDeployedError` the moment it is invoked — which is the
 * correct behaviour for a function in an account that does not exist.
 */
export async function handler(event: ProxyEvent): Promise<ProxyResult> {
  const { DynamoMetadataStore, S3FileStore } = await import("../adapters/aws-stores.js");
  const caller = callerOf(event);
  return routeRequest(event, {
    metadata: new DynamoMetadataStore({
      tableName: process.env["LEXICUE_TABLE"] ?? "",
      userId: caller.userId,
    }),
    files: new S3FileStore(process.env["LEXICUE_FILES_BUCKET"] ?? ""),
    downloads: {
      // Presigned GETs valid fifteen minutes (section 7.2).
      fileUrl: (jobId) => `s3://${process.env["LEXICUE_FILES_BUCKET"] ?? ""}/outputs/${jobId}`,
      zipUrl: (batchId) => `s3://${process.env["LEXICUE_FILES_BUCKET"] ?? ""}/zips/${batchId}.zip`,
    },
  });
}
