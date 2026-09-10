import { formatCents } from "@subtitle-translator/pricing";
import { pluralise } from "../../ui/format.js";
import "./ConfirmBar.css";

export interface Shortfall {
  shortfallCents: number;
  suggestedTopUpCents: number;
}

/**
 * The confirmation of spec section 2.1, step 4. The button carries the count
 * and the exact price — "Translate 8 files · $4.20" — with the balance beside
 * it, and when the balance is short it becomes "Top up $5 and translate"
 * instead of refusing.
 */
export function ConfirmBar({
  fileCount,
  totalCents,
  balanceCents,
  shortfall,
  blockedBecause,
  pending,
  error,
  onTranslate,
  onTopUp,
}: {
  fileCount: number;
  totalCents: number;
  balanceCents: number;
  shortfall: Shortfall | null;
  /** A sentence saying what is still missing, or null when ready. */
  blockedBecause: string | null;
  pending: boolean;
  error: string | null;
  onTranslate: () => void;
  onTopUp: (amountCents: number) => void;
}): React.JSX.Element {
  const short = shortfall !== null;

  return (
    <div className="confirm-bar">
      <div className="confirm-inner container">
        <div className="confirm-money">
          <span className="confirm-total num">{formatCents(totalCents)}</span>
          <span className="confirm-detail muted">
            for {pluralise(fileCount, "file")} · balance{" "}
            <span className="num">{formatCents(balanceCents)}</span>
          </span>
        </div>

        <div className="spacer" />

        {error === null ? null : <p className="confirm-error">{error}</p>}

        {blockedBecause === null ? null : <p className="confirm-hint muted">{blockedBecause}</p>}

        {short ? (
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={pending}
            onClick={() => {
              onTopUp(shortfall.suggestedTopUpCents);
            }}
          >
            Top up {formatCents(shortfall.suggestedTopUpCents)} and translate
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={pending || blockedBecause !== null || fileCount === 0}
            onClick={onTranslate}
          >
            {pending
              ? "Starting…"
              : `Translate ${pluralise(fileCount, "file")} · ${formatCents(totalCents)}`}
          </button>
        )}
      </div>
    </div>
  );
}
