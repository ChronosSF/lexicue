import {
  API_ROUTES,
  ApiError,
  ApiErrorResponseSchema,
  BatchListResponseSchema,
  BatchResponseSchema,
  CreateBatchResponseSchema,
  CreateUploadsResponseSchema,
  LanguagesResponseSchema,
  MeResponseSchema,
  PricingResponseSchema,
  TopUpResponseSchema,
  routePath,
  type BatchListResponse,
  type BatchResponse,
  type CreateBatchRequest,
  type CreateBatchResponse,
  type CreateUploadsRequest,
  type CreateUploadsResponse,
  type LanguagesResponse,
  type MeResponse,
  type PricingResponse,
  type RouteName,
  type TopUpRequest,
  type TopUpResponse,
  type UploadTarget,
} from "@subtitle-translator/shared";
import type { z } from "zod";
import type { BackendAdapter, Session } from "./types.js";

/**
 * The same interface against the deployed API of spec section 7.3: one `fetch`
 * per route, the Cognito JWT in the `Authorization` header, and every response
 * parsed with the shared schema before the UI sees it.
 *
 * Phase 2 stands the backend up. Until then this file compiles and is never
 * exercised, which is why the sign-in methods say plainly that they are not
 * wired rather than pretending to work: Cognito sign-in through Amplify Auth
 * belongs with the user pool it talks to.
 */

export interface RealBackendOptions {
  /** Defaults to the same origin, which is how CloudFront serves `/api/*`. */
  baseUrl?: string;
  /** The Cognito id token. Kept in memory or session storage, never a cookie. */
  getToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

const PHASE_TWO =
  "Sign-in is not wired up yet: the Cognito user pool arrives with the API in Phase 2. Run the app with VITE_BACKEND=mock to click through the product.";

export class RealBackend implements BackendAdapter {
  readonly kind = "real";
  readonly demo = null;

  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RealBackendOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.getToken = options.getToken ?? defaultToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getSession(): Promise<Session | null> {
    const token = await this.getToken();
    if (token === null) return null;
    const claims = readClaims(token);
    if (claims === null) return null;
    return {
      userId: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified,
    };
  }

  signIn(): Promise<Session> {
    return Promise.reject(new ApiError({ code: "unauthorised", message: PHASE_TWO }));
  }

  verifyEmail(): Promise<Session> {
    return Promise.reject(new ApiError({ code: "unauthorised", message: PHASE_TWO }));
  }

  signOut(): Promise<void> {
    globalThis.sessionStorage.removeItem(TOKEN_KEY);
    return Promise.resolve();
  }

  getMe(): Promise<MeResponse> {
    return this.call("getMe", MeResponseSchema);
  }

  getPricing(): Promise<PricingResponse> {
    return this.call("getPricing", PricingResponseSchema);
  }

  getLanguages(): Promise<LanguagesResponse> {
    return this.call("getLanguages", LanguagesResponseSchema);
  }

  createUploads(request: CreateUploadsRequest): Promise<CreateUploadsResponse> {
    return this.call("createUploads", CreateUploadsResponseSchema, { body: request });
  }

  /** The presigned POST: the bytes go to S3 and never touch the API Lambda. */
  async putUpload(target: UploadTarget, bytes: Uint8Array): Promise<void> {
    const form = new FormData();
    for (const [name, value] of Object.entries(target.fields)) form.append(name, value);
    form.append("file", new Blob([bytes as BlobPart], { type: "text/plain" }), target.fileName);

    const response = await this.fetchImpl(target.url, { method: "POST", body: form });
    if (!response.ok) {
      throw new ApiError({
        code: "bad-request",
        message: `${target.fileName} could not be uploaded. Try again.`,
      });
    }
  }

  createBatch(request: CreateBatchRequest): Promise<CreateBatchResponse> {
    return this.call("createBatch", CreateBatchResponseSchema, { body: request });
  }

  getBatch(batchId: string): Promise<BatchResponse> {
    return this.call("getBatch", BatchResponseSchema, { params: { id: batchId } });
  }

  listBatches(): Promise<BatchListResponse> {
    return this.call("listBatches", BatchListResponseSchema);
  }

  async deleteBatch(batchId: string): Promise<void> {
    await this.call("deleteBatch", null, { params: { id: batchId } });
  }

  createTopUp(request: TopUpRequest): Promise<TopUpResponse> {
    return this.call("createTopUp", TopUpResponseSchema, { body: request });
  }

  /** Stripe's webhook credits the balance; the SPA only polls `/api/me`. */
  completeCheckout(): Promise<void> {
    return Promise.resolve();
  }

  async deleteAccount(): Promise<void> {
    await this.call("deleteMe", null);
  }

  private async call<T>(
    name: RouteName,
    schema: z.ZodType<T> | null,
    options: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const route = API_ROUTES[name];
    const headers: Record<string, string> = {};
    if (route.auth === "jwt") {
      const token = await this.getToken();
      if (token === null)
        throw new ApiError({ code: "unauthorised", message: "Sign in to continue." });
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetchImpl(`${this.baseUrl}${routePath(name, options.params)}`, {
      method: route.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    if (!response.ok) throw await toApiError(response);
    if (schema === null) return undefined as T;
    return schema.parse(await response.json());
  }
}

const TOKEN_KEY = "subtitle-translator/id-token";

function defaultToken(): Promise<string | null> {
  return Promise.resolve(globalThis.sessionStorage.getItem(TOKEN_KEY));
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const parsed = ApiErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) return new ApiError(parsed.data.error);
  } catch {
    // A response that is not the contract's error shape falls through.
  }
  return new ApiError({
    code: "internal",
    message: "Something went wrong on our side. Nothing has been charged; try again in a moment.",
  });
}

interface TokenClaims {
  sub: string;
  email: string;
  email_verified: boolean;
}

/** Reads the claims for display only; the API validates the signature. */
function readClaims(token: string): TokenClaims | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const json: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof json !== "object" || json === null) return null;
    const claims = json as Partial<TokenClaims>;
    if (typeof claims.sub !== "string" || typeof claims.email !== "string") return null;
    return { sub: claims.sub, email: claims.email, email_verified: claims.email_verified === true };
  } catch {
    return null;
  }
}
