import { useRef, useState } from "react";
import "./Dropzone.css";
import { readDrop, readFile, type RawFile } from "./local-files.js";

/**
 * Drag and drop one file, several files, a folder or a zip (spec section 2.1).
 * The same region is a button, so the whole flow is reachable from the keyboard
 * and from a file picker on a phone.
 */
export function Dropzone({
  onFiles,
  compact,
  busy,
}: {
  onFiles: (files: RawFile[]) => void;
  compact?: boolean;
  busy?: boolean;
}): React.JSX.Element {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const open = (): void => input.current?.click();

  return (
    <div
      className={["dropzone", compact === true ? "is-compact" : "", over ? "is-over" : ""]
        .filter(Boolean)
        .join(" ")}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        void readDrop(event.dataTransfer).then(onFiles);
      }}
    >
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        multiple
        accept=".srt,.sub,.zip"
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          event.target.value = "";
          void Promise.all(chosen.map(readFile)).then(onFiles);
        }}
      />

      {compact === true ? (
        <button type="button" className="btn" onClick={open} disabled={busy === true}>
          Add more files
        </button>
      ) : (
        <div className="dropzone-body">
          <p className="dropzone-lead">Drop subtitle files here</p>
          <p className="dropzone-hint muted">
            One file, a whole season, a folder or a zip. SubRip (.srt), MicroDVD and SubViewer
            (.sub), up to 50 files and 5 MB each.
          </p>
          <button type="button" className="btn btn-primary" onClick={open} disabled={busy === true}>
            Choose files
          </button>
        </div>
      )}
    </div>
  );
}
