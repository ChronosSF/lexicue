import { z } from "zod";
import { CentsSchema, IdSchema } from "./common.js";

/**
 * Every failure the API can return, as one discriminated union. The codes are
 * what the SPA branches on; the `message` is the plain sentence the user reads
 * (spec section 2.3: never an error code).
 */

/** A file the product cannot use, with the sentence explaining why. */
export const UnusableFileSchema = z.object({
  uploadId: IdSchema.nullable(),
  fileName: z.string(),
  /** The `RejectionCode` of `packages/subtitles`, or a contract-level reason. */
  reason: z.string(),
  message: z.string(),
});

export const ApiErrorBodySchema = z.discriminatedUnion("code", [
  /** 401: no token, or one Cognito would not accept. */
  z.object({ code: z.literal("unauthorised"), message: z.string() }),
  /** 403: the account exists but has not verified its email (spec section 2.1). */
  z.object({ code: z.literal("email-not-verified"), message: z.string() }),
  /** 400: a request this contract does not describe. */
  z.object({ code: z.literal("bad-request"), message: z.string() }),
  /** 404. */
  z.object({ code: z.literal("not-found"), message: z.string() }),
  /**
   * 402: the balance will not cover the batch. The shortfall is included so the
   * SPA can offer the right top-up (spec section 7.3).
   */
  z.object({
    code: z.literal("insufficient-balance"),
    message: z.string(),
    totalCents: CentsSchema,
    balanceCents: CentsSchema,
    shortfallCents: CentsSchema,
    /** The smallest offered top-up that covers the shortfall. */
    suggestedTopUpCents: CentsSchema,
  }),
  /** 422: the upload contains files that cannot be translated. */
  z.object({
    code: z.literal("unusable-files"),
    message: z.string(),
    files: z.array(UnusableFileSchema),
  }),
  /** 422: the target language is the language the files are already in (3.3). */
  z.object({
    code: z.literal("target-is-source-language"),
    message: z.string(),
    sourceLanguage: z.string(),
  }),
  /** 429: a per-user limit from spec section 3.2. */
  z.object({
    code: z.literal("limit-exceeded"),
    message: z.string(),
    limit: z.string(),
  }),
  /** 500 and anything else that should never reach a user. */
  z.object({ code: z.literal("internal"), message: z.string() }),
]);

export const ApiErrorResponseSchema = z.object({ error: ApiErrorBodySchema });

export type UnusableFile = z.infer<typeof UnusableFileSchema>;
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
export type ApiErrorCode = ApiErrorBody["code"];

/** The HTTP status each code is returned with, so both adapters agree. */
export const STATUS_FOR_ERROR: Record<ApiErrorCode, number> = {
  unauthorised: 401,
  "email-not-verified": 403,
  "bad-request": 400,
  "not-found": 404,
  "insufficient-balance": 402,
  "unusable-files": 422,
  "target-is-source-language": 422,
  "limit-exceeded": 429,
  internal: 500,
};

/**
 * The error both backend adapters throw. The mock throws it directly; the real
 * one builds it from the response body, so the UI only ever handles one shape.
 */
export class ApiError extends Error {
  readonly body: ApiErrorBody;
  readonly status: number;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.body = body;
    this.status = STATUS_FOR_ERROR[body.code];
  }

  /** Narrows to one code, so callers can read the extra fields safely. */
  is<C extends ApiErrorCode>(
    code: C,
  ): this is ApiError & { body: Extract<ApiErrorBody, { code: C }> } {
    return this.body.code === code;
  }
}

/** True for the one error the confirm button turns into a top-up offer. */
export function isInsufficientBalance(
  error: unknown,
): error is ApiError & { body: Extract<ApiErrorBody, { code: "insufficient-balance" }> } {
  return error instanceof ApiError && error.is("insufficient-balance");
}
