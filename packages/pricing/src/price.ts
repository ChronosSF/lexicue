import { DEFAULT_RATE_TABLE, type Lane, type LaneRates, type RateTable } from "./rates.js";

/**
 * What a price is metered on: the dialogue of spec section 4.3, and how that
 * dialogue is cut into cues. Every parsed `SubtitleDocument` carries both, so
 * the preview in the browser and the charge on the server meter the same file
 * from the same two numbers.
 */
export interface Metered {
  dialogueChars: number;
  cueCount: number;
}

/**
 * What a parsed subtitle file is metered on. Structurally typed rather than
 * taking `SubtitleDocument`, so this package keeps its one job and its zero
 * dependencies, and every caller — the browser preview, the intake that
 * charges, the harness report, the eval — meters a document the same way.
 */
export function meteredOf(document: { dialogueChars: number; cues: readonly unknown[] }): Metered {
  return { dialogueChars: document.dialogueChars, cueCount: document.cues.length };
}

/** What a file costs, with the inputs and the rates that produced the number. */
export interface FilePrice {
  dialogueChars: number;
  cueCount: number;
  lane: Lane;
  rates: LaneRates;
  priceCents: number;
  /** True when the floor decided the price rather than the metered components. */
  atMinimum: boolean;
}

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, received ${String(value)}`);
  }
}

/**
 * The metered amount before the floor, in whole cents.
 *
 * The arithmetic is done on integers, with both components brought onto the
 * common denominator of 1,000 and rounded up once at the end:
 *
 *     metered = ceil((chars * centsPer1000Chars + cues * centsPer100Cues * 10) / 1000)
 *
 * so the result can never drift by a cent between two floating-point
 * evaluations of the same file, and a price is never rounded up twice. With the
 * default table's zero per-cue component the second term vanishes and this is
 * exactly the `ceil(dialogueChars / 1000 * rateCents)` of spec section 6.1.
 */
function meteredCents(file: Metered, rates: LaneRates): number {
  const chars = file.dialogueChars * rates.centsPer1000Chars;
  const cues = file.cueCount * rates.centsPer100Cues * 10;
  return Math.ceil((chars + cues) / 1000);
}

/**
 * The price of a file, computed identically in the browser preview and on the
 * server (spec section 6.1):
 *
 *     priceCents = max(minimum, metered characters + metered cues)
 *
 * The rate table travels with the request — `GET /api/pricing` carries it to
 * the SPA and Parameter Store carries it to the workers — so both sides compute
 * the same price from the same numbers. The price shown before confirmation is
 * the price charged.
 */
export function priceCents(
  file: Metered,
  lane: Lane,
  table: RateTable = DEFAULT_RATE_TABLE,
): number {
  assertCount("dialogueChars", file.dialogueChars);
  assertCount("cueCount", file.cueCount);
  const rates = table[lane];
  return Math.max(rates.minimumPriceCents, meteredCents(file, rates));
}

/** The price of a file with the inputs that produced it, for the preview table. */
export function priceFile(
  file: Metered,
  lane: Lane,
  table: RateTable = DEFAULT_RATE_TABLE,
): FilePrice {
  const rates = table[lane];
  const price = priceCents(file, lane, table);
  return {
    dialogueChars: file.dialogueChars,
    cueCount: file.cueCount,
    lane,
    rates: { ...rates },
    priceCents: price,
    atMinimum:
      price === rates.minimumPriceCents && meteredCents(file, rates) <= rates.minimumPriceCents,
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
