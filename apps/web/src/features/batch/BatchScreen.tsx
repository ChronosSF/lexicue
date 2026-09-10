import { formatCents } from "@subtitle-translator/pricing";
import type { Batch } from "@subtitle-translator/shared";
import { useBatch, useDeleteBatchFiles } from "../../app/queries.js";
import { useRoute } from "../../app/routes.js";
import { formatRelativeFuture, pluralise } from "../../ui/format.js";
import "./BatchScreen.css";
import { JobRow } from "./JobRow.js";
import { SeasonGlossaryPanel } from "./SeasonGlossaryPanel.js";

/**
 * The translating and done states of spec section 2. One row per file with its
 * own progress and its own download, a zip when the last one lands, the report
 * behind each row, and the season glossary under the batch.
 */
export function BatchScreen({ batchId }: { batchId: string }): React.JSX.Element {
  const { navigate } = useRoute();
  const batch = useBatch(batchId);
  const deleteFiles = useDeleteBatchFiles();

  if (batch.isPending) return <p className="muted">Loading this upload…</p>;
  if (batch.error !== null) {
    return (
      <section className="card card-pad">
        <p className="problem">{batch.error.message}</p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            navigate({ name: "translate" });
          }}
        >
          Start a new upload
        </button>
      </section>
    );
  }

  const data = batch.data;
  const running = data.status === "queued" || data.status === "running";
  const refunded = data.refundedCents > 0;

  return (
    <div className="batch stack-lg">
      <header className="batch-head">
        <div className="stack">
          <p className="eyebrow">
            {data.lane === "fast" ? "Fast lane" : "Economy lane"} · {data.targetLanguageName}
          </p>
          <h1>{headline(data)}</h1>
          {data.notice === null ? null : <p className="batch-notice">{data.notice}</p>}
        </div>

        <div className="batch-actions">
          {data.zipUrl === null ? null : (
            <a
              className="btn btn-primary"
              href={data.zipUrl}
              download={data.zipFileName ?? "subtitles.zip"}
            >
              Download all · {pluralise(data.doneCount, "file")}
            </a>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              navigate({ name: "translate" });
            }}
          >
            Translate more files
          </button>
        </div>
      </header>

      <section className="card batch-files">
        <ul className="batch-list">
          {data.jobs.map((job) => (
            <JobRow key={job.jobId} job={job} />
          ))}
        </ul>
      </section>

      {data.seasonGlossary === null ? null : <SeasonGlossaryPanel glossary={data.seasonGlossary} />}

      <section className="batch-footer">
        <p className="muted">
          Charged {formatCents(data.priceCents - data.refundedCents)}
          {refunded ? (
            <>
              {" "}
              after {formatCents(data.refundedCents)} refunded for{" "}
              {pluralise(data.failedCount, "file")} that failed
            </>
          ) : null}
          .
        </p>
        {data.filesExpireAt === null ? (
          <p className="faint">These files have been deleted.</p>
        ) : (
          <p className="faint">
            Files are deleted {formatRelativeFuture(data.filesExpireAt)}; the history row stays for
            30 days.{" "}
            {running ? null : (
              <button
                type="button"
                className="linkish"
                disabled={deleteFiles.isPending}
                onClick={() => {
                  deleteFiles.mutate(data.batchId);
                }}
              >
                Delete them now
              </button>
            )}
          </p>
        )}
      </section>
    </div>
  );
}

function headline(batch: Batch): string {
  const files = pluralise(batch.fileCount, "file");
  switch (batch.status) {
    case "queued":
    case "running":
      return `Translating ${files} into ${batch.targetLanguageName}`;
    case "submitted":
      return `${files} submitted for ${batch.targetLanguageName}`;
    case "done":
      return batch.fileCount === 1 ? "Your file is ready" : "Your files are ready";
    case "partial":
      return `Ready, with ${pluralise(batch.failedCount, "file")} refunded`;
    case "failed":
      return "Nothing could be translated, and everything was refunded";
  }
}
