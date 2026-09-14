import { DEFAULT_RATE_TABLE, LANES, type RateTable } from "@lexicue/pricing";
import { z } from "zod";
import { CentsSchema, LaneSchema } from "./common.js";

/**
 * `GET /api/pricing` and `GET /api/languages` of spec section 7.3. Both are
 * unauthenticated and cached at the edge, and the SPA prices its preview table
 * from the rates this route returns rather than from a constant of its own, so
 * a rate change in Parameter Store reaches the browser without a deploy
 * (spec section 9.8).
 *
 * The three numbers of a lane's `LaneRates` travel here in full, so the browser
 * and the server price a file with the same function from the same table and
 * cannot disagree about what a file costs.
 */

export const LaneRateSchema = z.object({
  lane: LaneSchema,
  centsPer1000Chars: z.int().nonnegative(),
  /** 8 on the fast lane and 4 on the economy lane today (spec section 6.1). */
  centsPer100Cues: z.int().nonnegative(),
  /** The floor that covers the glossary pass on a tiny file (section 6.4). */
  minimumPriceCents: CentsSchema,
  /** "About two minutes per film", "Usually within the hour". */
  delivery: z.string(),
  description: z.string(),
});

/** One row of the worked examples in spec section 6.1. */
export const PriceExampleSchema = z.object({
  label: z.string(),
  dialogueChars: z.int(),
  /** The same file's cue count from spec section 5.3, which the price may meter. */
  cueCount: z.int(),
  fastCents: CentsSchema,
  economyCents: CentsSchema,
});

export const PricingResponseSchema = z.object({
  rates: z.array(LaneRateSchema),
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

/**
 * The rate table the route carried, ready to price with. This is the join that
 * makes "the price previewed is the price charged" a property of the code
 * rather than of two constants that happen to agree: the SPA prices its preview
 * with the table it was served, and the server charges with the table it
 * served. A lane missing from the response keeps its default rates, so a
 * response from an older deployment still prices every file.
 */
export function rateTableOf(rates: readonly LaneRate[]): RateTable {
  const table = {} as RateTable;
  for (const lane of LANES) {
    const served = rates.find((rate) => rate.lane === lane);
    table[lane] = served
      ? {
          centsPer1000Chars: served.centsPer1000Chars,
          centsPer100Cues: served.centsPer100Cues,
          minimumPriceCents: served.minimumPriceCents,
        }
      : { ...DEFAULT_RATE_TABLE[lane] };
  }
  return table;
}
