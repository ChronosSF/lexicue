import { formatCents } from "@lexicue/pricing";
import type { FileReport } from "@lexicue/shared";
import { formatCount, pluralise } from "../../ui/format.js";
import "./FileReportPanel.css";

/**
 * The report of spec section 3.5, as the file's row shows it: how many cues
 * were translated, which ones were left in the source language and where they
 * are, and the advisory reading-speed and line-length flags that tell an editor
 * where a hand edit may be worth it.
 */
export function FileReportPanel({ report }: { report: FileReport }): React.JSX.Element {
  const untranslated = report.untranslatedCues;

  return (
    <div className="report">
      <ul className="report-stats">
        <Stat
          label="Translated"
          value={`${formatCount(report.translatedCues)} of ${formatCount(report.totalCues)} cues`}
          tone={report.translatedCues === report.totalCues ? "ok" : "warn"}
        />
        <Stat
          label="Reading speed"
          value={
            report.readingSpeedFindings.length === 0
              ? "Nothing flagged"
              : pluralise(report.readingSpeedFindings.length, "cue")
          }
          tone={report.readingSpeedFindings.length === 0 ? "ok" : "warn"}
        />
        <Stat
          label="Line length"
          value={
            report.longLines.length === 0
              ? "Nothing flagged"
              : pluralise(report.longLines.length, "line")
          }
          tone={report.longLines.length === 0 ? "ok" : "warn"}
        />
        <Stat
          label="Glossary"
          value={pluralise(report.glossaryEntriesApplied, "entry", "entries")}
        />
      </ul>

      {untranslated.length > 0 ? (
        <section className="report-section">
          <h4 className="eyebrow">Left in the source language</h4>
          <p className="hint">
            These cues came back untranslated after their retries, so they were delivered as they
            were. Their index and timecode are here so they can be fixed by hand.
          </p>
          <div className="table-wrap">
            <table className="data report-table">
              <thead>
                <tr>
                  <th scope="col">Cue</th>
                  <th scope="col">Timecode</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {untranslated.slice(0, 20).map((cue) => (
                  <tr key={cue.id}>
                    <td className="num">{cue.index ?? cue.id}</td>
                    <td className="mono">{cue.timing}</td>
                    <td>{cue.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {untranslated.length > 20 ? (
            <p className="hint">
              and {formatCount(untranslated.length - 20)} more, all listed in the stored report.
            </p>
          ) : null}
        </section>
      ) : null}

      {report.readingSpeedFindings.length > 0 || report.longLines.length > 0 ? (
        <section className="report-section">
          <h4 className="eyebrow">Advisory</h4>
          <p className="hint">
            The standard yardsticks subtitle editors use: over <span className="num">20</span>{" "}
            characters a second is hard to read, and a line over <span className="num">42</span>{" "}
            characters is hard to fit. Neither changes the file.
          </p>
          <div className="table-wrap">
            <table className="data report-table">
              <thead>
                <tr>
                  <th scope="col">Cue</th>
                  <th scope="col">Timecode</th>
                  <th scope="col">Finding</th>
                </tr>
              </thead>
              <tbody>
                {report.readingSpeedFindings.slice(0, 8).map((finding) => (
                  <tr key={`speed-${finding.id.toString()}`}>
                    <td className="num">{finding.id}</td>
                    <td className="mono">{finding.timing}</td>
                    <td>
                      <span className="num">{finding.charsPerSecond}</span> characters a second
                    </td>
                  </tr>
                ))}
                {report.longLines.slice(0, 8).map((finding) => (
                  <tr key={`line-${finding.id.toString()}-${finding.length.toString()}`}>
                    <td className="num">{finding.id}</td>
                    <td className="mono">{finding.timing}</td>
                    <td>
                      A line of <span className="num">{finding.length}</span> characters
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {report.warnings.length > 0 || report.repairs.length > 0 ? (
        <section className="report-section">
          <h4 className="eyebrow">Notes on the source file</h4>
          <ul className="report-notes">
            {[...report.warnings, ...report.repairs].map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <dl className="report-meta">
        <Meta label="Model" value={report.model} />
        <Meta label="Prompt" value={report.promptVersion} />
        <Meta label="Effort" value={report.effort} />
        <Meta label="Batches" value={formatCount(report.batches)} />
        <Meta label="Wall time" value={`${(report.wallTimeMs / 1000).toFixed(1)} s`} />
        <Meta label="Charged" value={formatCents(report.priceCents)} />
      </dl>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}): React.JSX.Element {
  return (
    <li className="report-stat">
      <span className="report-stat-label">{label}</span>
      <span className={tone === undefined ? "report-stat-value" : `report-stat-value is-${tone}`}>
        {value}
      </span>
    </li>
  );
}

function Meta({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}
