/** The two delivery lanes of spec section 6.2. */
export const LANES = ["fast", "economy"] as const;

export type Lane = (typeof LANES)[number];

/** True when the value is one of the two lanes. */
export function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value);
}

/**
 * What one lane charges. Three numbers, because a subtitle file costs money in
 * two shapes and earns it in one:
 *
 * - `centsPer1000Chars` is the metered price of spec section 6.1.
 * - `centsPer100Cues` is a per-cue component, which exists because the
 *   measurements of 12 and 14 September 2026 found that a real part of the
 *   model cost is per cue and not per character (the id and the
 *   `{"i":…,"t":"…"}` wrapper are the same size whether a cue holds four words
 *   or fourteen), so a dense, short-cue file costs more to produce per
 *   character and earns less. See the analysis in the root README.
 * - `minimumPriceCents` is the floor that covers the glossary pass on a tiny
 *   file (spec section 6.4).
 *
 * Per 100 cues rather than per cue because the price is in whole cents and a
 * per-cue figure that mattered would be a fraction of one: a 1,400-cue film at
 * 8 cents per 100 cues pays $1.12 of cue component.
 */
export interface LaneRates {
  centsPer1000Chars: number;
  centsPer100Cues: number;
  minimumPriceCents: number;
}

/** The rate table: what each lane charges. One object, one source of truth. */
export type RateTable = Record<Lane, LaneRates>;

/**
 * Today's prices, and the table every caller gets when none travels with the
 * request. Adopted on 14 September 2026, replacing spec section 6.1's pure
 * per-character rates of 3 cents per 1,000 characters on the fast lane and 2 on
 * the economy lane, which carried no per-cue component.
 *
 * The change is option A of the pricing analysis in the root README, and it is
 * sized to leave the headline price alone: every file small enough to sit at the
 * 10-cent floor — eleven of the thirteen eval fixtures — pays exactly what it
 * paid before, and spec section 5.3's own 1,400-cue feature film gets 8 cents
 * cheaper rather than dearer. What moves is the shape the measurements found
 * under-earning, the long file of short, dense cues: `drama/the-signal-box.srt`
 * goes from 41 to 46 cents and `comedy/the-inventory.srt` from 94 cents to
 * $1.12, lifting them from 28.1% and 32.6% margin to 35.3% and 42.5%.
 *
 * The economy lane keeps the discount it has measured rather than widening it:
 * 4 cents against the fast lane's 8 holds it at roughly one third off across
 * every shape, which is where it sits today.
 *
 * These are product decisions: in the deployed system they come from Parameter
 * Store (spec section 9.8) and reach the browser through `GET /api/pricing`, so
 * a rate change needs no deploy — but a change to the defaults here needs a
 * changelog entry naming the old and new rates (spec section 9.5).
 */
export const DEFAULT_RATE_TABLE: RateTable = {
  fast: { centsPer1000Chars: 1, centsPer100Cues: 8, minimumPriceCents: 10 },
  economy: { centsPer1000Chars: 1, centsPer100Cues: 4, minimumPriceCents: 10 },
};

/** Top-up amounts offered at checkout, with $10 preselected (spec section 6.3). */
export const TOP_UP_AMOUNTS_CENTS = [500, 1000, 2500] as const;
export const DEFAULT_TOP_UP_CENTS = 1000;

/** The one-off balance a verified email receives (spec section 6.5). */
export const FREE_BALANCE_CENTS = 250;
