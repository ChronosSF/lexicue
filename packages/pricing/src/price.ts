import { MINIMUM_PRICE_CENTS, RATE_CENTS_PER_1000_CHARS, type Lane } from "./rates.js";

/** What a file costs, with the inputs that produced the number. */
export interface FilePrice {
  dialogueChars: number;
  lane: Lane;
  rateCents: number;
  priceCents: number;
  /** True when the 10-cent floor decided the price rather than the rate. */
  atMinimum: boolean;
}

/**
 * The metered price of spec section 6.1, computed identically in the browser
 * preview and on the server:
 *
 *     priceCents = max(10, ceil(dialogueChars / 1000 * rateCents))
 *
 * The arithmetic is done on integers (`chars * rate` before the division) so
 * the result can never drift by a cent between two floating-point evaluations
 * of the same file. The price shown before confirmation is the price charged.
 */
export function priceCents(dialogueChars: number, lane: Lane): number {
  if (!Number.isInteger(dialogueChars) || dialogueChars < 0) {
    throw new RangeError(
      `dialogueChars must be a non-negative integer, received ${String(dialogueChars)}`,
    );
  }
  const rateCents = RATE_CENTS_PER_1000_CHARS[lane];
  const metered = Math.ceil((dialogueChars * rateCents) / 1000);
  return Math.max(MINIMUM_PRICE_CENTS, metered);
}

/** The price of a file with the inputs that produced it, for the preview table. */
export function priceFile(dialogueChars: number, lane: Lane): FilePrice {
  const rateCents = RATE_CENTS_PER_1000_CHARS[lane];
  const price = priceCents(dialogueChars, lane);
  return {
    dialogueChars,
    lane,
    rateCents,
    priceCents: price,
    atMinimum:
      price === MINIMUM_PRICE_CENTS &&
      Math.ceil((dialogueChars * rateCents) / 1000) <= MINIMUM_PRICE_CENTS,
  };
}

/** Renders cents the way every price in the product is written: "$1.80". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const remainder = (absolute % 100).toString().padStart(2, "0");
  return `${sign}$${whole.toString()}.${remainder}`;
}
