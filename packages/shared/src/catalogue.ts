import { z } from "zod";
import { CentsSchema, LaneSchema } from "./common.js";

/**
 * `GET /api/pricing` and `GET /api/languages` of spec section 7.3. Both are
 * unauthenticated and cached at the edge, and the SPA prices its preview table
 * from the rates this route returns rather than from a constant of its own, so
 * a rate change in Parameter Store reaches the browser without a deploy
 * (spec section 9.8).
 */

export const LaneRateSchema = z.object({
  lane: LaneSchema,
  centsPer1000Chars: z.int(),
  /** "About two minutes per film", "Usually within the hour". */
  delivery: z.string(),
  description: z.string(),
});

/** One row of the worked examples in spec section 6.1. */
export const PriceExampleSchema = z.object({
  label: z.string(),
  dialogueChars: z.int(),
  fastCents: CentsSchema,
  economyCents: CentsSchema,
});

export const PricingResponseSchema = z.object({
  rates: z.array(LaneRateSchema),
  minimumPriceCents: CentsSchema,
  topUpAmountsCents: z.array(CentsSchema),
  defaultTopUpCents: CentsSchema,
  freeBalanceCents: CentsSchema,
  examples: z.array(PriceExampleSchema),
});

export const TargetLanguageSchema = z.object({
  code: z.string(),
  name: z.string(),
  script: z.string(),
  /** Languages with a T-V distinction, where the formality setting matters. */
  hasFormalityDistinction: z.boolean(),
});

export const LanguagesResponseSchema = z.object({
  languages: z.array(TargetLanguageSchema),
});

export type LaneRate = z.infer<typeof LaneRateSchema>;
export type PriceExample = z.infer<typeof PriceExampleSchema>;
export type PricingResponse = z.infer<typeof PricingResponseSchema>;
export type TargetLanguage = z.infer<typeof TargetLanguageSchema>;
export type LanguagesResponse = z.infer<typeof LanguagesResponseSchema>;
