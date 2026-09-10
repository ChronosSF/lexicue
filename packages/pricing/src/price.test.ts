import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatCents, priceCents, priceFile } from "./price.js";
import {
  DEFAULT_TOP_UP_CENTS,
  FREE_BALANCE_CENTS,
  LANES,
  MINIMUM_PRICE_CENTS,
  RATE_CENTS_PER_1000_CHARS,
  TOP_UP_AMOUNTS_CENTS,
  isLane,
} from "./rates.js";

/**
 * The worked examples of spec section 6.1, pinned as fixed expectations. These
 * are the numbers printed in the specification's price table; if one of them
 * moves, the change is a product decision, not a refactor.
 */
const SPEC_TABLE = [
  { file: "Sitcom episode, 22 min", chars: 16_000, fast: 48, economy: 32 },
  { file: "Drama episode, 45 min", chars: 30_000, fast: 90, economy: 60 },
  { file: "Feature film, 2 h", chars: 60_000, fast: 180, economy: 120 },
  { file: "3 h film with hearing-impaired cues", chars: 120_000, fast: 360, economy: 240 },
  { file: "A ten-episode season of 45-minute drama", chars: 300_000, fast: 900, economy: 600 },
];

describe("the price table in spec section 6.1", () => {
  it.each(SPEC_TABLE)("$file costs $fast cents fast and $economy cents economy", (row) => {
    expect(priceCents(row.chars, "fast")).toBe(row.fast);
    expect(priceCents(row.chars, "economy")).toBe(row.economy);
  });

  it.each(SPEC_TABLE)("$file renders as the dollars the spec prints", (row) => {
    expect(formatCents(priceCents(row.chars, "fast"))).toBe(`$${(row.fast / 100).toFixed(2)}`);
    expect(formatCents(priceCents(row.chars, "economy"))).toBe(
      `$${(row.economy / 100).toFixed(2)}`,
    );
  });
});

describe("the rates", () => {
  it("is 3 cents per 1,000 characters on the fast lane and 2 on the economy lane", () => {
    expect(RATE_CENTS_PER_1000_CHARS.fast).toBe(3);
    expect(RATE_CENTS_PER_1000_CHARS.economy).toBe(2);
  });

  it("offers $5, $10 and $25 top-ups with $10 preselected", () => {
    expect(TOP_UP_AMOUNTS_CENTS).toEqual([500, 1000, 2500]);
    expect(DEFAULT_TOP_UP_CENTS).toBe(1000);
    expect(TOP_UP_AMOUNTS_CENTS).toContain(DEFAULT_TOP_UP_CENTS);
  });

  it("grants $2.50 of free balance", () => {
    expect(FREE_BALANCE_CENTS).toBe(250);
    expect(formatCents(FREE_BALANCE_CENTS)).toBe("$2.50");
  });

  it("recognises the two lanes and nothing else", () => {
    expect(LANES).toEqual(["fast", "economy"]);
    expect(isLane("fast")).toBe(true);
    expect(isLane("economy")).toBe(true);
    expect(isLane("express")).toBe(false);
  });
});

describe("the minimum price", () => {
  it("is 10 cents, which covers the glossary pass on a tiny file", () => {
    expect(MINIMUM_PRICE_CENTS).toBe(10);
    expect(priceCents(0, "fast")).toBe(10);
    expect(priceCents(1, "fast")).toBe(10);
    expect(priceCents(1000, "fast")).toBe(10);
  });

  it("stops applying exactly where the metered price overtakes it", () => {
    // 3 cents per 1,000 characters reaches 10 cents at 3,334 characters.
    expect(priceCents(3333, "fast")).toBe(10);
    expect(priceCents(3334, "fast")).toBe(11);
    // 2 cents per 1,000 characters reaches 10 cents at 5,001 characters.
    expect(priceCents(5000, "economy")).toBe(10);
    expect(priceCents(5001, "economy")).toBe(11);
  });

  it("reports whether the floor decided the price", () => {
    expect(priceFile(1000, "fast").atMinimum).toBe(true);
    expect(priceFile(60_000, "fast").atMinimum).toBe(false);
  });
});

describe("rounding", () => {
  it("rounds a part-thousand up to the next cent", () => {
    expect(priceCents(60_001, "fast")).toBe(181);
    expect(priceCents(60_333, "fast")).toBe(181);
    expect(priceCents(60_334, "fast")).toBe(182);
    expect(priceCents(60_500, "economy")).toBe(121);
  });

  it("never charges a fraction of a cent", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.constantFrom(...LANES),
        (chars, lane) => {
          expect(Number.isInteger(priceCents(chars, lane))).toBe(true);
        },
      ),
    );
  });
});

describe("the price is a pure, monotone function of characters and lane", () => {
  it("never gets cheaper as a file gets longer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.constantFrom(...LANES),
        (chars, extra, lane) => {
          expect(priceCents(chars + extra, lane)).toBeGreaterThanOrEqual(priceCents(chars, lane));
        },
      ),
    );
  });

  it("never costs more on the economy lane than on the fast lane", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000 }), (chars) => {
        expect(priceCents(chars, "economy")).toBeLessThanOrEqual(priceCents(chars, "fast"));
      }),
    );
  });

  it("gives the same answer every time it is asked", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.constantFrom(...LANES),
        (chars, lane) => {
          expect(priceCents(chars, lane)).toBe(priceCents(chars, lane));
        },
      ),
    );
  });

  it("is a third cheaper on the economy lane once past the floor", () => {
    for (const chars of [16_000, 30_000, 60_000, 120_000, 300_000]) {
      expect(priceCents(chars, "economy") / priceCents(chars, "fast")).toBeCloseTo(2 / 3, 10);
    }
  });
});

describe("priceFile", () => {
  it("returns the inputs alongside the price, for the preview table", () => {
    expect(priceFile(60_000, "fast")).toEqual({
      dialogueChars: 60_000,
      lane: "fast",
      rateCents: 3,
      priceCents: 180,
      atMinimum: false,
    });
  });
});

describe("bad input", () => {
  it("refuses a negative or fractional character count", () => {
    expect(() => priceCents(-1, "fast")).toThrow(RangeError);
    expect(() => priceCents(1.5, "fast")).toThrow(RangeError);
    expect(() => priceCents(Number.NaN, "fast")).toThrow(RangeError);
  });
});

describe("formatCents", () => {
  it("always shows two decimal places", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(48)).toBe("$0.48");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(1240)).toBe("$12.40");
  });

  it("puts the sign before the dollar mark for a refund", () => {
    expect(formatCents(-180)).toBe("-$1.80");
  });
});
