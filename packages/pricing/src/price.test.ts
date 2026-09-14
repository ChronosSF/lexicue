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
 *
 * They moved once, on 14 September 2026, when the rate went from 3 and 2 cents
 * per 1,000 characters to 1 cent per 1,000 characters plus 8 and 4 cents per
 * 100 cues. The cue counts are load-bearing now: under the old table they were
 * decoration and every one of these prices came from the character column
 * alone.
 */
const SPEC_TABLE = [
  { file: "Sitcom episode, 22 min", chars: 16_000, cues: 350, fast: 44, economy: 30 },
  { file: "Drama episode, 45 min", chars: 30_000, cues: 650, fast: 82, economy: 56 },
  { file: "Feature film, 2 h", chars: 60_000, cues: 1_400, fast: 172, economy: 116 },
  {
    file: "3 h film with hearing-impaired cues",
    chars: 120_000,
    cues: 2_600,
    fast: 328,
    economy: 224,
  },
  {
    file: "A ten-episode season of 45-minute drama",
    chars: 300_000,
    cues: 6_500,
    fast: 820,
    economy: 560,
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
  it("is 1 cent per 1,000 characters on both lanes", () => {
    expect(DEFAULT_RATE_TABLE.fast.centsPer1000Chars).toBe(1);
    expect(DEFAULT_RATE_TABLE.economy.centsPer1000Chars).toBe(1);
  });

  it("charges 8 cents per 100 cues on the fast lane and 4 on the economy lane", () => {
    expect(DEFAULT_RATE_TABLE.fast.centsPer100Cues).toBe(8);
    expect(DEFAULT_RATE_TABLE.economy.centsPer100Cues).toBe(4);
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
 * The regression that matters: the default table charges for cues as well as
 * characters, so how a file is cut up now moves its price. This is the whole
 * point of the 14 September 2026 rate change — a dense file of short cues costs
 * more to produce per character, and now pays for it.
 */
describe("with the default table the price depends on cues as well as characters", () => {
  it("charges a dense file more than a sparse one of the same length", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.constantFrom(...LANES),
        (chars, cues, lane) => {
          expect(priceCents(file(chars, cues), lane)).toBeGreaterThanOrEqual(
            priceCents(file(chars, 0), lane),
          );
        },
      ),
    );
  });

  it("prices the dense shapes the measurements found", () => {
    // The two full-length fixtures, at 33.3 and 31.2 characters per cue. Under
    // the per-character price they replaced these were 41, 94 and 27 cents, and
    // returned 28.1% and 32.6% margin against the film shape's 50.8%.
    expect(priceCents(file(13_339, 400), "fast")).toBe(46);
    expect(priceCents(file(31_241, 1_000), "fast")).toBe(112);
    expect(priceCents(file(13_339, 400), "economy")).toBe(30);
    expect(priceCents(file(31_241, 1_000), "economy")).toBe(72);
  });

  it("leaves every file at the floor priced exactly as it was", () => {
    // Eleven of the thirteen eval fixtures sit here, and the rate change was
    // sized so that none of them moved a cent.
    expect(priceCents(file(1_062, 38), "fast")).toBe(10);
    expect(priceCents(file(1_062, 38), "economy")).toBe(10);
    expect(priceCents(file(539, 23), "fast")).toBe(10);
    expect(priceCents(file(798, 30), "fast")).toBe(10);
    expect(priceCents(file(759, 28), "fast")).toBe(10);
  });
});

describe("the minimum price", () => {
  it("is 10 cents", () => {
    expect(priceCents(file(0), "fast")).toBe(10);
    expect(priceCents(file(1), "fast")).toBe(10);
    expect(priceCents(file(1000, 38), "fast")).toBe(10);
  });

  it("stops applying exactly where the metered price overtakes it", () => {
    // 1 cent per 1,000 characters reaches 10 cents at 10,001 characters, on
    // either lane, since both charge the same for characters.
    expect(priceCents(file(10_000), "fast")).toBe(10);
    expect(priceCents(file(10_001), "fast")).toBe(11);
    expect(priceCents(file(10_000), "economy")).toBe(10);
    expect(priceCents(file(10_001), "economy")).toBe(11);
    // 8 cents per 100 cues reaches 10 cents at 126 cues on the fast lane, and
    // 4 cents per 100 at 251 cues on the economy lane.
    expect(priceCents(file(0, 125), "fast")).toBe(10);
    expect(priceCents(file(0, 126), "fast")).toBe(11);
    expect(priceCents(file(0, 250), "economy")).toBe(10);
    expect(priceCents(file(0, 251), "economy")).toBe(11);
  });

  it("reports whether the floor decided the price", () => {
    expect(priceFile(file(1000), "fast").atMinimum).toBe(true);
    expect(priceFile(file(60_000, 1_400), "fast").atMinimum).toBe(false);
  });
});

describe("rounding", () => {
  it("rounds a part-thousand up to the next cent", () => {
    expect(priceCents(file(60_000), "fast")).toBe(60);
    expect(priceCents(file(60_001), "fast")).toBe(61);
    expect(priceCents(file(60_999), "fast")).toBe(61);
    expect(priceCents(file(61_000), "fast")).toBe(61);
  });

  it("rounds a part-hundred of cues up to the next cent too", () => {
    // 1,400 cues at 8 cents per 100 is $1.12 exactly; one more cue is a cent.
    expect(priceCents(file(0, 1_400), "fast")).toBe(112);
    expect(priceCents(file(0, 1_401), "fast")).toBe(113);
    expect(priceCents(file(0, 1_400), "economy")).toBe(56);
  });

  it("rounds the two components up once together, not once each", () => {
    // 20,400 characters is 20.4 cents and 45 cues is 3.6 cents: 24 cents
    // exactly together, where rounding each separately would have charged 25.
    expect(priceCents(file(20_400, 45), "fast")).toBe(24);
    expect(priceCents(file(20_400, 0), "fast")).toBe(21);
    expect(priceCents(file(0, 45), "fast")).toBe(10); // 3.6 cents, under the floor
    expect(priceCents(file(500, 50), "fast")).toBe(10); // still under the floor
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

  it("is about a third cheaper on the economy lane, on every shape the spec prices", () => {
    // Both lanes charge the same per character and the economy lane half as
    // much per cue, so the discount is no longer the exact two thirds the pure
    // per-character table gave: it is 31.7% to 32.6% off across section 6.1's
    // own five shapes. The exact cents are pinned in SPEC_TABLE above; this is
    // the property that decides the lane's margin.
    for (const row of SPEC_TABLE) {
      const ratio = row.economy / row.fast;
      expect(ratio).toBeGreaterThan(0.67);
      expect(ratio).toBeLessThan(0.69);
      expect(priceCents(file(row.chars, row.cues), "economy") / row.fast).toBe(ratio);
    }
  });

  it("charges both lanes alike on a file with no cues to discount", () => {
    // The discount rides entirely on the cue component, so a hypothetical file
    // of characters and no cues is the same price on either lane. No real
    // subtitle file is that shape, which is why the band above is the test.
    expect(priceCents(file(60_000), "economy")).toBe(priceCents(file(60_000), "fast"));
  });
});

/**
 * The table is configuration. Option A of the analysis in the root README is
 * now the default and is tested above; the two tables below are other shapes
 * the same arithmetic has to price correctly, including option B's higher
 * floor, which the founder did not take.
 */
describe("a table with a different per-cue component", () => {
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
      rates: { centsPer1000Chars: 1, centsPer100Cues: 8, minimumPriceCents: 10 },
      priceCents: 172,
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
