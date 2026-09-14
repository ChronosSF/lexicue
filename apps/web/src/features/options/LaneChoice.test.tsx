import { DEFAULT_RATE_TABLE, LANES } from "@lexicue/pricing";
import type { LaneRate } from "@lexicue/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LaneChoice } from "./LaneChoice.js";

/**
 * The lane cards of spec section 6.2 state the rate the upload is priced at, so
 * what they say has to be what the rate table says — including the per-cue
 * component, which is zero today and therefore absent from the card.
 */

function ratesFrom(table = DEFAULT_RATE_TABLE): LaneRate[] {
  return LANES.map((lane) => ({
    lane,
    ...table[lane],
    delivery: lane === "fast" ? "About two minutes per film" : "Usually within the hour",
    description: "The same model and the same guarantees.",
  }));
}

describe("LaneChoice", () => {
  it("states each lane's character rate and this upload's price on it", () => {
    render(
      <LaneChoice
        rates={ratesFrom()}
        value="fast"
        totals={{ fast: 180, economy: 120 }}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText("3c per 1,000 characters of dialogue")).toBeInTheDocument();
    expect(screen.getByText("2c per 1,000 characters of dialogue")).toBeInTheDocument();
    expect(screen.getByText("$1.80")).toBeInTheDocument();
    expect(screen.getByText("$1.20")).toBeInTheDocument();
  });

  it("says nothing about cues while the per-cue component is zero", () => {
    render(
      <LaneChoice
        rates={ratesFrom()}
        value="fast"
        totals={{ fast: 180, economy: 120 }}
        onChange={() => undefined}
      />,
    );
    expect(screen.queryByText(/per 100 cues/)).not.toBeInTheDocument();
  });

  it("adds the per-cue line as soon as a rate table charges for cues", () => {
    render(
      <LaneChoice
        rates={ratesFrom({
          fast: { centsPer1000Chars: 2, centsPer100Cues: 4, minimumPriceCents: 10 },
          economy: { centsPer1000Chars: 1, centsPer100Cues: 3, minimumPriceCents: 10 },
        })}
        value="fast"
        totals={{ fast: 176, economy: 102 }}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText("plus 4c per 100 cues")).toBeInTheDocument();
    expect(screen.getByText("plus 3c per 100 cues")).toBeInTheDocument();
  });
});
