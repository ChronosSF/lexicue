import { formatCents, type Lane } from "@subtitle-translator/pricing";
import { formatBytes, formatCount, formatDuration, formatName } from "../../ui/format.js";
import "./FileTable.css";
import type { LocalFile } from "./local-files.js";

/**
 * The preview table of spec section 2.1: what the app understood about every
 * file and what it will cost on each lane, before anything is charged. A file
 * it cannot use explains itself in place and can be removed on its own.
 */
export function FileTable({
  files,
  lane,
  onRemove,
}: {
  files: LocalFile[];
  lane: Lane;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="table-wrap file-table">
      <table className="data">
        <caption className="visually-hidden">
          The files in this upload, with their format, size and price
        </caption>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Format</th>
            <th scope="col">Encoding</th>
            <th scope="col" className="right">
              Cues
            </th>
            <th scope="col" className="right">
              Characters
            </th>
            <th scope="col" className="right">
              Running time
            </th>
            <th scope="col" className="right">
              Fast
            </th>
            <th scope="col" className="right">
              Economy
            </th>
            <th scope="col">
              <span className="visually-hidden">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) =>
            file.preview === null ? (
              <tr key={file.id} className="is-problem">
                <td>
                  <div className="file-name">{file.fileName}</div>
                  <div className="file-sub faint">{formatBytes(file.byteLength)}</div>
                </td>
                <td colSpan={7}>
                  <p className="problem">{file.problem}</p>
                </td>
                <td className="right">
                  <RemoveButton
                    fileName={file.fileName}
                    onRemove={() => {
                      onRemove(file.id);
                    }}
                  />
                </td>
              </tr>
            ) : (
              <tr key={file.id}>
                <td>
                  <div className="file-name">{file.fileName}</div>
                  <div className="file-sub faint">
                    {formatBytes(file.byteLength)}
                    {file.preview.warnings.length > 0 ? (
                      <>
                        {" · "}
                        <span title={file.preview.warnings.join("\n")}>
                          {file.preview.warnings.length === 1
                            ? "1 note"
                            : `${file.preview.warnings.length.toString()} notes`}
                        </span>
                      </>
                    ) : null}
                  </div>
                </td>
                <td>{formatName(file.preview.format)}</td>
                <td>
                  <span className="mono">{file.preview.encoding}</span>
                  {file.preview.bom ? <span className="faint"> +BOM</span> : null}
                </td>
                <td className="right num">{formatCount(file.preview.cueCount)}</td>
                <td className="right num">{formatCount(file.preview.dialogueChars)}</td>
                <td className="right num">{formatDuration(file.preview.runningTimeMs)}</td>
                <td className={lane === "fast" ? "right num price is-chosen" : "right num price"}>
                  {formatCents(file.preview.priceCents.fast)}
                </td>
                <td
                  className={lane === "economy" ? "right num price is-chosen" : "right num price"}
                >
                  {formatCents(file.preview.priceCents.economy)}
                </td>
                <td className="right">
                  <RemoveButton
                    fileName={file.fileName}
                    onRemove={() => {
                      onRemove(file.id);
                    }}
                  />
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function RemoveButton({
  fileName,
  onRemove,
}: {
  fileName: string;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>
      <span aria-hidden="true">✕</span>
      <span className="visually-hidden">Remove {fileName}</span>
    </button>
  );
}
