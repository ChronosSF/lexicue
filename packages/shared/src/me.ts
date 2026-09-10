import { z } from "zod";
import { BatchSummarySchema } from "./batches.js";
import { CentsSchema, DeltaCentsSchema, IdSchema, InstantSchema } from "./common.js";

/** `GET /api/me` and `DELETE /api/me` of spec section 7.3. */

/** Why the balance moved (spec section 7.4). */
export const LedgerReasonSchema = z.enum(["topup", "grant", "charge", "refund"]);

export const LedgerEntrySchema = z.object({
  id: IdSchema,
  at: InstantSchema,
  deltaCents: DeltaCentsSchema,
  reason: LedgerReasonSchema,
  /** Batch id, job id or Stripe event id, depending on the reason. */
  ref: z.string().nullable(),
  /** The sentence the history row shows, for example "Translated 3 files". */
  description: z.string(),
  balanceAfter: CentsSchema,
  /** How much of a charge came out of the free grant (spec section 6.5). */
  freeDeltaCents: DeltaCentsSchema,
});

/** The per-user limits of spec section 3.2, with the counters they are checked against. */
export const LimitsSchema = z.object({
  maxFilesPerUpload: z.int(),
  maxUploadBytes: z.int(),
  maxFileBytes: z.int(),
  maxCuesPerFile: z.int(),
  /** Files translating at once on the fast lane; the rest queue in order. */
  concurrentFastFiles: z.int(),
  maxFilesPerDay: z.int(),
  filesRunning: z.int(),
  filesToday: z.int(),
});

export const UserSchema = z.object({
  userId: IdSchema,
  email: z.email(),
  /** Verification is what grants the free balance (spec section 2.1). */
  emailVerified: z.boolean(),
  createdAt: InstantSchema,
});

export const MeResponseSchema = z.object({
  user: UserSchema,
  /** Total balance in cents; the free portion is part of it, not extra. */
  balanceCents: CentsSchema,
  /** The unspent part of the $2.50 grant, shown separately while it lasts. */
  freeCents: CentsSchema,
  limits: LimitsSchema,
  recentBatches: z.array(BatchSummarySchema),
  /**
   * The 30 days of transactions the wallet screen shows (spec section 2.2).
   * Section 7.3 gives no separate route for them, so they ride on `/api/me`.
   */
  transactions: z.array(LedgerEntrySchema),
});

export type LedgerReason = z.infer<typeof LedgerReasonSchema>;
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type User = z.infer<typeof UserSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
