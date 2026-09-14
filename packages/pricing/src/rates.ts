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
 * - `centsPer1000Chars` is the metered price of spec section 6.1, and the only
 *   component that is non-zero today.
 * - `centsPer100Cues` is a per-cue component, zero by default, so the table can
 *   express what the measurements of 12 and 14 September 2026 found: a real
 *   part of the model cost is per cue and not per character (the id and the
 *   `{"i":…,"t":"…"}` wrapper are the same size whether a cue holds four words
 *   or fourteen), so a dense, short-cue file costs more to produce per
 *   character and earns less. See the analysis in the root README.
 * - `minimumPriceCents` is the floor that covers the glossary pass on a tiny
 *   file (spec section 6.4).
 *
 * Per 100 cues rather than per cue because the price is in whole cents and a
 * per-cue figure that mattered would be a fraction of one: a 1,400-cue film at
 * 6 cents per 100 cues pays 84 cents of cue component.
 */
export interface LaneRates {
  centsPer1000Chars: number;
  centsPer100Cues: number;
  minimumPriceCents: number;
}

/** The rate table: what each lane charges. One object, one source of truth. */
export type RateTable = Record<Lane, LaneRates>;

/**
 * Today's prices (spec section 6.1), and the table every caller gets when none
 * travels with the request. The per-cue component is zero and the floor is 10
 * cents, so this table reproduces the pure per-character price the product has
 * charged since launch, to the cent, on every file.
 *
 * These are product decisions: in the deployed system they come from Parameter
 * Store (spec section 9.8) and reach the browser through `GET /api/pricing`, so
 * a rate change needs no deploy — but a change to the defaults here needs a
 * changelog entry naming the old and new rates (spec section 9.5).
 */
export const DEFAULT_RATE_TABLE: RateTable = {
  fast: { centsPer1000Chars: 3, centsPer100Cues: 0, minimumPriceCents: 10 },
  economy: { centsPer1000Chars: 2, centsPer100Cues: 0, minimumPriceCents: 10 },
};

/** Top-up amounts offered at checkout, with $10 preselected (spec section 6.3). */
export const TOP_UP_AMOUNTS_CENTS = [500, 1000, 2500] as const;
export const DEFAULT_TOP_UP_CENTS = 1000;

/** The one-off balance a verified email receives (spec section 6.5). */
export const FREE_BALANCE_CENTS = 250;
