import { DEFAULT_RATE_TABLE, LANES } from "@lexicue/pricing";
import type { LaneRate } from "@lexicue/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LaneChoice } from "./LaneChoice.js";

/**
 * The lane cards of spec section 6.2 state the rate the upload is priced at, so
 * what they say has to be what the rate table says — including the per-cue
 * component, which since 14 September 2026 is the whole visible difference
 * between the two lanes' rates.
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
  it("states each lane's rate in full and this upload's price on it", () => {
    render(
      <LaneChoice
        rates={ratesFrom()}
        value="fast"
        totals={{ fast: 172, economy: 116 }}
        onChange={() => undefined}
      />,
    );
    // Both lanes charge 1 cent per 1,000 characters, so the per-cue clause is
    // the whole difference between what the two cards say.
    expect(
      screen.getByText("1c per 1,000 characters of dialogue, plus 8c per 100 cues"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("1c per 1,000 characters of dialogue, plus 4c per 100 cues"),
    ).toBeInTheDocument();
    expect(screen.getByText("$1.72")).toBeInTheDocument();
    expect(screen.getByText("$1.16")).toBeInTheDocument();
  });

  it("reads as one sentence per card, rate then cue component", () => {
    render(
      <LaneChoice
        rates={ratesFrom()}
        value="fast"
        totals={{ fast: 46, economy: 30 }}
        onChange={() => undefined}
      />,
    );
    // One element, so the rate is one clause to a screen reader rather than
    // "of dialogueplus 8c per 100 cues".
    expect(screen.getByRole("radio", { name: /Fast/ })).toHaveAccessibleName(
      /\$0\.46.*1c per 1,000 characters of dialogue, plus 8c per 100 cues$/,
    );
    expect(screen.getByRole("radio", { name: /Economy/ })).toHaveAccessibleName(
      /\$0\.30.*1c per 1,000 characters of dialogue, plus 4c per 100 cues$/,
    );
  });

  it("drops the per-cue line for a rate table that does not charge for cues", () => {
    render(
      <LaneChoice
        rates={ratesFrom({
          fast: { centsPer1000Chars: 3, centsPer100Cues: 0, minimumPriceCents: 10 },
          economy: { centsPer1000Chars: 2, centsPer100Cues: 0, minimumPriceCents: 10 },
        })}
        value="fast"
        totals={{ fast: 180, economy: 120 }}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText("3c per 1,000 characters of dialogue")).toBeInTheDocument();
    expect(screen.queryByText(/per 100 cues/)).not.toBeInTheDocument();
  });
});
