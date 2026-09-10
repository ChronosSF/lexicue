/** The two delivery lanes of spec section 6.2. */
export const LANES = ["fast", "economy"] as const;

export type Lane = (typeof LANES)[number];

/** True when the value is one of the two lanes. */
export function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value);
}

/**
 * Cents per 1,000 characters of dialogue (spec section 6.1). These are product
 * decisions: in the deployed system they come from Parameter Store, and a change
 * to the defaults here needs a changelog entry naming the old and new rates
 * (spec section 9.5).
 */
export const RATE_CENTS_PER_1000_CHARS: Record<Lane, number> = {
  fast: 3,
  economy: 2,
};

/** The floor that covers the glossary pass on a tiny file (spec section 6.4). */
export const MINIMUM_PRICE_CENTS = 10;

/** Top-up amounts offered at checkout, with $10 preselected (spec section 6.3). */
export const TOP_UP_AMOUNTS_CENTS = [500, 1000, 2500] as const;
export const DEFAULT_TOP_UP_CENTS = 1000;

/** The one-off balance a verified email receives (spec section 6.5). */
export const FREE_BALANCE_CENTS = 250;
