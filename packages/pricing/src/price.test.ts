import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatCents, meteredOf, priceCents, priceFile, type Metered } from "./price.js";
import {
  DEFAULT_RATE_TABLE,
  DEFAULT_TOP_UP_CENTS,
  FREE_BALANCE_CENTS,
  LANES,
  TOP_UP_AMOUNTS_CENTS,
  isLane,
  type RateTable,
} from "./rates.js";

/**
 * The worked examples of spec section 6.1, pinned as fixed expectations, with
 * the cue counts spec section 5.3 gives the same files. These are the numbers
 * printed in the specification's price table; if one of them moves, the change
 * is a product decision, not a refactor.
 */
const SPEC_TABLE = [
  { file: "Sitcom episode, 22 min", chars: 16_000, cues: 350, fast: 48, economy: 32 },
  { file: "Drama episode, 45 min", chars: 30_000, cues: 650, fast: 90, economy: 60 },
  { file: "Feature film, 2 h", chars: 60_000, cues: 1_400, fast: 180, economy: 120 },
  {
    file: "3 h film with hearing-impaired cues",
    chars: 120_000,
    cues: 2_600,
    fast: 360,
    economy: 240,
  },
  {
    file: "A ten-episode season of 45-minute drama",
    chars: 300_000,
    cues: 6_500,
    fast: 900,
    economy: 600,
  },
];

const file = (dialogueChars: number, cueCount = 0): Metered => ({ dialogueChars, cueCount });

describe("the price table in spec section 6.1", () => {
  it.each(SPEC_TABLE)("$file costs $fast cents fast and $economy cents economy", (row) => {
    expect(priceCents(file(row.chars, row.cues), "fast")).toBe(row.fast);
    expect(priceCents(file(row.chars, row.cues), "economy")).toBe(row.economy);
  });

  it.each(SPEC_TABLE)("$file renders as the dollars the spec prints", (row) => {
    expect(formatCents(priceCents(file(row.chars, row.cues), "fast"))).toBe(
      `$${(row.fast / 100).toFixed(2)}`,
    );
    expect(formatCents(priceCents(file(row.chars, row.cues), "economy"))).toBe(
      `$${(row.economy / 100).toFixed(2)}`,
    );
  });
});

describe("the default rate table", () => {
  it("is 3 cents per 1,000 characters on the fast lane and 2 on the economy lane", () => {
    expect(DEFAULT_RATE_TABLE.fast.centsPer1000Chars).toBe(3);
    expect(DEFAULT_RATE_TABLE.economy.centsPer1000Chars).toBe(2);
  });

  it("charges nothing per cue, so today's price is purely per character", () => {
    expect(DEFAULT_RATE_TABLE.fast.centsPer100Cues).toBe(0);
    expect(DEFAULT_RATE_TABLE.economy.centsPer100Cues).toBe(0);
  });

  it("floors both lanes at 10 cents, which covers the glossary pass on a tiny file", () => {
    expect(DEFAULT_RATE_TABLE.fast.minimumPriceCents).toBe(10);
    expect(DEFAULT_RATE_TABLE.economy.minimumPriceCents).toBe(10);
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

/**
 * The regression that matters: the table can now express a per-cue component,
 * and today it does not. However a file is cut into cues, the default table
 * charges what the pure per-character price of spec section 6.1 charged.
 */
describe("with the default table the price does not depend on cues at all", () => {
  it("prices a file the same however many cues it is cut into", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.constantFrom(...LANES),
        (chars, cues, lane) => {
          expect(priceCents(file(chars, cues), lane)).toBe(priceCents(file(chars, 0), lane));
        },
      ),
    );
  });

  it("prices the dense shapes the measurements found exactly as it always has", () => {
    // The two full-length fixtures, at 33.3 and 31.2 characters per cue.
    expect(priceCents(file(13_339, 400), "fast")).toBe(41);
    expect(priceCents(file(31_241, 1_000), "fast")).toBe(94);
    expect(priceCents(file(13_339, 400), "economy")).toBe(27);
  });
});

describe("the minimum price", () => {
  it("is 10 cents", () => {
    expect(priceCents(file(0), "fast")).toBe(10);
    expect(priceCents(file(1), "fast")).toBe(10);
    expect(priceCents(file(1000, 38), "fast")).toBe(10);
  });

  it("stops applying exactly where the metered price overtakes it", () => {
    // 3 cents per 1,000 characters reaches 10 cents at 3,334 characters.
    expect(priceCents(file(3333), "fast")).toBe(10);
    expect(priceCents(file(3334), "fast")).toBe(11);
    // 2 cents per 1,000 characters reaches 10 cents at 5,001 characters.
    expect(priceCents(file(5000), "economy")).toBe(10);
    expect(priceCents(file(5001), "economy")).toBe(11);
  });

  it("reports whether the floor decided the price", () => {
    expect(priceFile(file(1000), "fast").atMinimum).toBe(true);
    expect(priceFile(file(60_000, 1_400), "fast").atMinimum).toBe(false);
  });
});

describe("rounding", () => {
  it("rounds a part-thousand up to the next cent", () => {
    expect(priceCents(file(60_001), "fast")).toBe(181);
    expect(priceCents(file(60_333), "fast")).toBe(181);
    expect(priceCents(file(60_334), "fast")).toBe(182);
    expect(priceCents(file(60_500), "economy")).toBe(121);
  });

  it("rounds the two components up once together, not once each", () => {
    // 500 characters is 1.5 cents and 50 cues is 3.5 cents: 5 cents together,
    // where rounding each separately would have charged 6.
    const table = withCueRate(7);
    expect(priceCents(file(500, 50), "fast", table)).toBe(10); // still under the floor
    expect(priceCents(file(20_500, 50), "fast", table)).toBe(65);
    expect(priceCents(file(20_500, 0), "fast", table)).toBe(62);
  });

  it("never charges a fraction of a cent", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.constantFrom(...LANES),
        (chars, cues, lane) => {
          expect(Number.isInteger(priceCents(file(chars, cues), lane, withCueRate(6)))).toBe(true);
        },
      ),
    );
  });
});

describe("the price is a pure, monotone function of its inputs and the table", () => {
  it("never gets cheaper as a file gets longer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.constantFrom(...LANES),
        (chars, extra, lane) => {
          expect(priceCents(file(chars + extra), lane)).toBeGreaterThanOrEqual(
            priceCents(file(chars), lane),
          );
        },
      ),
    );
  });

  it("never gets cheaper as a file gains cues, under a table that charges for them", () => {
    const table = withCueRate(6);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.constantFrom(...LANES),
        (chars, cues, extra, lane) => {
          expect(priceCents(file(chars, cues + extra), lane, table)).toBeGreaterThanOrEqual(
            priceCents(file(chars, cues), lane, table),
          );
        },
      ),
    );
  });

  it("never costs more on the economy lane than on the fast lane", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        (chars, cues) => {
          expect(priceCents(file(chars, cues), "economy")).toBeLessThanOrEqual(
            priceCents(file(chars, cues), "fast"),
          );
        },
      ),
    );
  });

  it("gives the same answer every time it is asked", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.constantFrom(...LANES),
        (chars, cues, lane) => {
          expect(priceCents(file(chars, cues), lane)).toBe(priceCents(file(chars, cues), lane));
        },
      ),
    );
  });

  it("is a third cheaper on the economy lane once past the floor", () => {
    for (const chars of [16_000, 30_000, 60_000, 120_000, 300_000]) {
      expect(priceCents(file(chars), "economy") / priceCents(file(chars), "fast")).toBeCloseTo(
        2 / 3,
        10,
      );
    }
  });
});

/**
 * The table is configuration, and these are the shapes the analysis in the root
 * README asks the founder to choose between. None of them is the default.
 */
describe("a table with a per-cue component", () => {
  const blended: RateTable = {
    fast: { centsPer1000Chars: 2, centsPer100Cues: 4, minimumPriceCents: 10 },
    economy: { centsPer1000Chars: 1, centsPer100Cues: 3, minimumPriceCents: 10 },
  };

  it("charges the cue component on top of the character component", () => {
    // 60,000 characters at 2c/1,000 is 120c; 1,400 cues at 4c/100 is 56c.
    expect(priceCents(file(60_000, 1_400), "fast", blended)).toBe(176);
    expect(priceCents(file(60_000, 1_400), "economy", blended)).toBe(102);
  });

  it("charges a dense file more than a sparse one of the same length", () => {
    const dense = priceCents(file(30_000, 1_200), "fast", blended);
    const sparse = priceCents(file(30_000, 600), "fast", blended);
    expect(dense).toBeGreaterThan(sparse);
    expect(dense - sparse).toBe(24);
  });

  it("still floors a tiny file", () => {
    expect(priceCents(file(200, 8), "fast", blended)).toBe(10);
  });
});

describe("a table with a higher floor", () => {
  const raised: RateTable = {
    fast: { centsPer1000Chars: 3, centsPer100Cues: 0, minimumPriceCents: 25 },
    economy: { centsPer1000Chars: 2, centsPer100Cues: 0, minimumPriceCents: 15 },
  };

  it("floors each lane at its own minimum", () => {
    expect(priceCents(file(1_062, 38), "fast", raised)).toBe(25);
    expect(priceCents(file(1_062, 38), "economy", raised)).toBe(15);
  });

  it("leaves a file already above the floor alone", () => {
    expect(priceCents(file(60_000, 1_400), "fast", raised)).toBe(180);
  });
});

describe("priceFile", () => {
  it("returns the inputs and the rates alongside the price, for the preview table", () => {
    expect(priceFile(file(60_000, 1_400), "fast")).toEqual({
      dialogueChars: 60_000,
      cueCount: 1_400,
      lane: "fast",
      rates: { centsPer1000Chars: 3, centsPer100Cues: 0, minimumPriceCents: 10 },
      priceCents: 180,
      atMinimum: false,
    });
  });

  it("copies the rates rather than handing out the table's own object", () => {
    const price = priceFile(file(60_000, 1_400), "fast");
    expect(price.rates).not.toBe(DEFAULT_RATE_TABLE.fast);
    expect(price.rates).toEqual(DEFAULT_RATE_TABLE.fast);
  });
});

describe("meteredOf", () => {
  it("meters a parsed document on its dialogue and its cue count", () => {
    expect(meteredOf({ dialogueChars: 13_339, cues: new Array(400).fill(null) })).toEqual({
      dialogueChars: 13_339,
      cueCount: 400,
    });
  });

  it("prices a document straight from the parse", () => {
    const document = { dialogueChars: 1_062, cues: new Array(38).fill(null) };
    expect(priceCents(meteredOf(document), "fast")).toBe(10);
  });
});

describe("bad input", () => {
  it("refuses a negative or fractional character count", () => {
    expect(() => priceCents(file(-1), "fast")).toThrow(RangeError);
    expect(() => priceCents(file(1.5), "fast")).toThrow(RangeError);
    expect(() => priceCents(file(Number.NaN), "fast")).toThrow(RangeError);
  });

  it("refuses a negative or fractional cue count", () => {
    expect(() => priceCents(file(1_000, -1), "fast")).toThrow(RangeError);
    expect(() => priceCents(file(1_000, 2.5), "fast")).toThrow(RangeError);
    expect(() => priceCents(file(1_000, Number.NaN), "fast")).toThrow(RangeError);
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

/** The default table with one lever moved, for the tests that need a non-zero cue rate. */
function withCueRate(centsPer100Cues: number): RateTable {
  return {
    fast: { ...DEFAULT_RATE_TABLE.fast, centsPer100Cues },
    economy: { ...DEFAULT_RATE_TABLE.economy, centsPer100Cues },
  };
}
