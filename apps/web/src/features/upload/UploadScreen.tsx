import { formatCents, type Lane } from "@subtitle-translator/pricing";
import { MAX_FILES_PER_UPLOAD } from "@subtitle-translator/subtitles";
import { useState } from "react";
import { joinWords, pluralise } from "../../ui/format.js";
import { Dropzone } from "./Dropzone.js";
import { FileTable } from "./FileTable.js";
import { SampleTray } from "./SampleTray.js";
import "./UploadScreen.css";
import { intake, totalCents, usableFiles, type LocalFile, type RawFile } from "./local-files.js";

/**
 * The upload state of spec section 2: drop files, see exactly what the app
 * understood and what it will cost, take out anything unusable, and go on to
 * the language and the lane.
 */
export function UploadScreen(): React.JSX.Element {
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const lane: Lane = "fast";

  const add = (raw: RawFile[]): void => {
    setFiles((current) => {
      const result = intake(raw, current);
      setIgnored(result.ignored);
      return [...current, ...result.files].slice(0, MAX_FILES_PER_UPLOAD);
    });
  };

  const remove = (id: string): void => {
    setFiles((current) => current.filter((file) => file.id !== id));
  };

  const usable = usableFiles(files);
  const problems = files.length - usable.length;

  return (
    <div className="upload stack-lg">
      {files.length === 0 ? (
        <section className="hero stack">
          <h1>Translate a subtitle file, or a whole season.</h1>
          <p className="hero-lead">
            Every cue index, timecode, positioning tag and formatting tag comes back exactly as it
            went in. Only the spoken text changes. You see the price of every file before anything
            is charged.
          </p>
        </section>
      ) : null}

      <Dropzone onFiles={add} compact={files.length > 0} />

      {files.length === 0 ? (
        <SampleTray onFiles={add} />
      ) : (
        <section className="stack">
          <div className="upload-summary row">
            <h2 className="card-title">
              {pluralise(usable.length, "file")}
              {problems > 0 ? (
                <span className="chip chip-danger upload-problem-count">
                  {pluralise(problems, "file")} cannot be translated
                </span>
              ) : null}
            </h2>
            <div className="spacer" />
            <span className="muted">
              {formatCents(totalCents(usable, lane))} on the fast lane ·{" "}
              {formatCents(totalCents(usable, "economy"))} on the economy lane
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setFiles([]);
                setIgnored([]);
              }}
            >
              Start again
            </button>
          </div>

          <FileTable files={files} lane={lane} onRemove={remove} />

          {ignored.length > 0 ? (
            <p className="hint">
              Ignored {joinWords(ignored.slice(0, 4))}
              {ignored.length > 4 ? ` and ${(ignored.length - 4).toString()} more` : ""}: only
              SubRip and the two `.sub` dialects can be translated.
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}
