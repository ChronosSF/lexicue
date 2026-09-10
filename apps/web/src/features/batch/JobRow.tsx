import { formatCents } from "@subtitle-translator/pricing";
import type { Job } from "@subtitle-translator/shared";
import { useState } from "react";
import { formatCount, formatName } from "../../ui/format.js";
import { FileReportPanel } from "./FileReportPanel.js";
import "./JobRow.css";

/**
 * One file, in every state it can be in (spec section 2.1, steps 5 and 6): a
 * progress bar driven by batches completed out of total, a download as soon as
 * that file is finished, the plain sentence when it failed and was refunded,
 * and its report a click away.
 */
export function JobRow({ job }: { job: Job }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const percent =
    job.batchesTotal === 0 ? 0 : Math.round((job.batchesDone / job.batchesTotal) * 100);

  return (
    <li className={`job-row is-${job.status}`}>
      <div className="job-main">
        <div className="job-identity">
          <span className="job-name">{job.fileName}</span>
          <span className="job-meta faint">
            {formatName(job.format)} · {formatCount(job.cueCount)} cues ·{" "}
            {formatCount(job.dialogueChars)} characters ·{" "}
            {job.status === "failed" ? (
              <span className="job-refunded">{formatCents(job.refundedCents)} refunded</span>
            ) : (
              formatCents(job.priceCents)
            )}
          </span>
        </div>

        <div className="job-state">
          <JobStatus job={job} percent={percent} />
        </div>

        <div className="job-actions">
          {job.status === "done" && job.downloadUrl !== null ? (
            <a
              className="btn btn-primary btn-sm"
              href={job.downloadUrl}
              download={job.outputFileName}
            >
              Download
            </a>
          ) : null}
          {job.report === null ? null : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-expanded={open}
              onClick={() => {
                setOpen((wasOpen) => !wasOpen);
              }}
            >
              {open ? "Hide report" : "Report"}
            </button>
          )}
        </div>
      </div>

      {job.status === "running" || job.status === "submitted" || job.status === "queued" ? (
        <div
          className="bar job-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={job.batchesTotal}
          aria-valuenow={job.batchesDone}
          aria-label={`${job.fileName} progress`}
        >
          <i style={{ width: `${percent.toString()}%` }} />
        </div>
      ) : null}

      {job.error === null ? null : <p className="job-error">{job.error}</p>}

      {open && job.report !== null ? <FileReportPanel report={job.report} /> : null}
    </li>
  );
}

function JobStatus({ job, percent }: { job: Job; percent: number }): React.JSX.Element {
  switch (job.status) {
    case "queued":
      return <span className="chip">Waiting its turn</span>;
    case "running":
      return (
        <span className="chip chip-accent num">
          {job.batchesDone} of {job.batchesTotal} batches · {percent}%
        </span>
      );
    case "submitted":
      return <span className="chip chip-info">Submitted to the batch</span>;
    case "done":
      return (
        <span className="chip chip-ok">
          {job.report !== null && job.report.untranslatedCues.length > 0
            ? `${formatCount(job.report.translatedCues)} of ${formatCount(job.report.totalCues)} cues translated`
            : "Translated"}
        </span>
      );
    case "failed":
      return <span className="chip chip-danger">Refunded</span>;
  }
}
