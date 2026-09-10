import { z } from "zod";
import { CentsSchema, IdSchema } from "./common.js";

/**
 * `POST /api/uploads` of spec section 7.3: presigned POSTs for 1 to 50 files,
 * at most 5 MB each and 25 MB in total. Files never pass through the API; the
 * browser puts the bytes straight into object storage with these credentials.
 */

export const UploadRequestFileSchema = z.object({
  fileName: z.string().min(1),
  byteLength: z.int().min(1),
});

export const CreateUploadsRequestSchema = z.object({
  files: z.array(UploadRequestFileSchema).min(1).max(50),
});

/** One presigned POST: where to send the bytes and what to send with them. */
export const UploadTargetSchema = z.object({
  uploadId: IdSchema,
  fileName: z.string(),
  url: z.string(),
  /** The policy fields, sent as form data alongside the file. */
  fields: z.record(z.string(), z.string()),
  /** The `content-length-range` ceiling the policy enforces. */
  maxBytes: z.int(),
  expiresAt: z.string(),
});

export const CreateUploadsResponseSchema = z.object({
  uploads: z.array(UploadTargetSchema),
});

/** `POST /api/billing/topup` of spec section 7.3. */
export const TopUpRequestSchema = z.object({
  amountCents: CentsSchema,
});

export const TopUpResponseSchema = z.object({
  /** Stripe's hosted Checkout page; the mock backend serves its own instead. */
  checkoutUrl: z.string(),
  sessionId: IdSchema,
  amountCents: CentsSchema,
});

export type UploadRequestFile = z.infer<typeof UploadRequestFileSchema>;
export type CreateUploadsRequest = z.infer<typeof CreateUploadsRequestSchema>;
export type UploadTarget = z.infer<typeof UploadTargetSchema>;
export type CreateUploadsResponse = z.infer<typeof CreateUploadsResponseSchema>;
export type TopUpRequest = z.infer<typeof TopUpRequestSchema>;
export type TopUpResponse = z.infer<typeof TopUpResponseSchema>;
