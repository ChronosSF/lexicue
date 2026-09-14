import { formatCents, type Lane } from "@lexicue/pricing";
import type { LaneRate } from "@lexicue/shared";
import "./LaneChoice.css";

/**
 * The delivery choice of spec section 6.2, with the price of this upload on
 * each lane next to it. Both lanes use the same model, the same prompts and the
 * same guarantees; only the waiting differs, and the cards say so.
 */
export function LaneChoice({
  rates,
  value,
  totals,
  onChange,
}: {
  rates: LaneRate[];
  value: Lane;
  totals: Record<Lane, number>;
  onChange: (lane: Lane) => void;
}): React.JSX.Element {
  return (
    <fieldset className="lane-choice">
      <legend className="label">Delivery</legend>
      <div className="lane-cards">
        {rates.map((rate) => {
          const chosen = rate.lane === value;
          return (
            <label key={rate.lane} className={chosen ? "lane-card is-chosen" : "lane-card"}>
              <input
                type="radio"
                name="lane"
                className="visually-hidden"
                value={rate.lane}
                checked={chosen}
                onChange={() => {
                  onChange(rate.lane);
                }}
              />
              <span className="lane-head">
                <span className="lane-name">{rate.lane === "fast" ? "Fast" : "Economy"}</span>
                <span className="lane-price num">{formatCents(totals[rate.lane])}</span>
              </span>
              <span className="lane-delivery">{rate.delivery}</span>
              <span className="lane-note faint">{rate.description}</span>
              <span className="lane-rate faint num">
                {rate.centsPer1000Chars}c per 1,000 characters of dialogue
              </span>
              {/*
                The per-cue component of spec section 6.1 is zero today, so this
                line is absent and the card reads exactly as it always has. It
                appears the moment a rate table with a cue component is served.
              */}
              {rate.centsPer100Cues > 0 ? (
                <span className="lane-rate faint num">
                  plus {rate.centsPer100Cues}c per 100 cues
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
