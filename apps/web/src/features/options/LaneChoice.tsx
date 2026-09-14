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
              {/*
                The whole rate in one sentence, because both halves of it are
                one price: the per-cue component of spec section 6.1 is 8 cents
                per 100 cues on the fast lane and 4 on the economy lane since
                14 September 2026, and since both lanes charge the same per
                character it is the only visible difference between the two
                cards. One element rather than two so that a screen reader says
                "of dialogue, plus 8c per 100 cues" rather than running the two
                lines together; it is still the clause that is conditional, so a
                rate table that zeroes the cue component leaves the card reading
                as a plain per-character price rather than "plus 0c".
              */}
              <span className="lane-rate faint num">
                {rate.centsPer1000Chars}c per 1,000 characters of dialogue
                {rate.centsPer100Cues > 0
                  ? `, plus ${rate.centsPer100Cues.toString()}c per 100 cues`
                  : ""}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
