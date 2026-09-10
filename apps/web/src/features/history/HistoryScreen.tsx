import { formatCents } from "@subtitle-translator/pricing";
import type { BatchSummary } from "@subtitle-translator/shared";
import { useHistory } from "../../app/queries.js";
import { useRoute } from "../../app/routes.js";
import { formatDateTime, joinWords, pluralise } from "../../ui/format.js";
import "./HistoryScreen.css";

/**
 * The history of spec section 2.2: every upload of the last 30 days with its
 * date, files, language, lane, price and status. Files themselves are gone
 * after 24 hours, and a row says so rather than offering a download that would
 * fail.
 */
export function HistoryScreen(): React.JSX.Element {
  const history = useHistory();
  const { navigate } = useRoute();

  return (
    <div className="history stack-lg">
      <header className="stack">
        <p className="eyebrow">History</p>
        <h1>Your uploads</h1>
        <p className="muted">
          Kept for 30 days. The translated files themselves are deleted 24 hours after an upload
          finishes.
        </p>
      </header>

      {history.data === undefined ? (
        <p className="muted">Loading…</p>
      ) : history.data.length === 0 ? (
        <section className="card card-pad">
          <p className="muted">
            Nothing here yet. Your first upload will appear the moment it starts.
          </p>
        </section>
      ) : (
        <ul className="history-list">
          {history.data.map((batch) => (
            <li key={batch.batchId}>
              <button
                type="button"
                className="history-row"
                onClick={() => {
                  navigate({ name: "batch", batchId: batch.batchId });
                }}
              >
                <span className="history-when muted">{formatDateTime(batch.createdAt)}</span>
                <span className="history-files">
                  <span className="history-names">{joinWords(batch.fileNames.slice(0, 3))}</span>
                  {batch.fileNames.length > 3 ? (
                    <span className="faint">
                      {" "}
                      and {(batch.fileNames.length - 3).toString()} more
                    </span>
                  ) : null}
                  <span className="history-meta faint">
                    {batch.targetLanguageName} · {batch.lane === "fast" ? "fast" : "economy"} ·{" "}
                    {pluralise(batch.fileCount, "file")}
                  </span>
                </span>
                <StatusChip batch={batch} />
                <span className="history-price num">
                  {formatCents(batch.priceCents - batch.refundedCents)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusChip({ batch }: { batch: BatchSummary }): React.JSX.Element {
  switch (batch.status) {
    case "done":
      return <span className="chip chip-ok">Delivered</span>;
    case "partial":
      return (
        <span className="chip chip-warn">{pluralise(batch.failedCount, "file")} refunded</span>
      );
    case "failed":
      return <span className="chip chip-danger">Refunded</span>;
    case "submitted":
      return <span className="chip chip-info">Waiting on the batch</span>;
    case "queued":
    case "running":
      return <span className="chip chip-accent">Translating</span>;
  }
}
