import type { TranslationOptions } from "@lexicue/shared";
import { useId } from "react";
import "./OptionsPanel.css";

const MAX_CONTEXT_NOTE = 500;

/**
 * The translation options of spec sections 3.1 and 3.4. Formality and the
 * context note are in the open because they change the translation; line
 * handling, lyrics and the byte-order mark are one fold down, because most
 * people never touch them and the defaults are the right answer.
 */
export function OptionsPanel({
  options,
  onChange,
}: {
  options: TranslationOptions;
  onChange: (options: TranslationOptions) => void;
}): React.JSX.Element {
  const formalityId = useId();
  const noteId = useId();
  const remaining = MAX_CONTEXT_NOTE - options.contextNote.length;

  const update = (patch: Partial<TranslationOptions>): void => {
    onChange({ ...options, ...patch });
  };

  return (
    <div className="options">
      <div className="field">
        <label className="label" htmlFor={formalityId}>
          Formality
        </label>
        <select
          id={formalityId}
          className="select"
          value={options.formality}
          onChange={(event) => {
            update({ formality: event.target.value as TranslationOptions["formality"] });
          }}
        >
          <option value="auto">Auto — take the register from the dialogue</option>
          <option value="formal">Formal</option>
          <option value="informal">Informal</option>
        </select>
      </div>

      <div className="field">
        <label className="label" htmlFor={noteId}>
          Context note <span className="faint">optional</span>
        </label>
        <textarea
          id={noteId}
          className="textarea"
          maxLength={MAX_CONTEXT_NOTE}
          placeholder="1970s police drama, keep character names, “the Captain” is a woman"
          value={options.contextNote}
          onChange={(event) => {
            update({ contextNote: event.target.value });
          }}
        />
        <p className="hint">
          Goes into the glossary and applies to every file in the upload.{" "}
          <span className="num">{remaining}</span> characters left.
        </p>
      </div>

      <details className="options-more">
        <summary>More options</summary>
        <div className="options-more-body">
          <label className="check">
            <input
              type="checkbox"
              checked={options.outputBom}
              onChange={(event) => {
                update({ outputBom: event.target.checked });
              }}
            />
            <span>
              Write a byte-order mark
              <span className="hint">
                UTF-8 with the mark is the safest choice for consumer players. Turn it off if your
                player shows odd characters on the first line.
              </span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={options.lineHandling === "keep-source-line-count"}
              onChange={(event) => {
                update({
                  lineHandling: event.target.checked ? "keep-source-line-count" : "reflow",
                });
              }}
            />
            <span>
              Keep the original line count
              <span className="hint">
                By default lines are re-flowed for the target language, within two lines per cue.
              </span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={options.translateLyrics}
              onChange={(event) => {
                update({ translateLyrics: event.target.checked });
              }}
            />
            <span>
              Translate song lyrics
              <span className="hint">
                Lyrics under music notes. Sound descriptions and speaker labels in brackets are
                always translated and stay in brackets.
              </span>
            </span>
          </label>
        </div>
      </details>
    </div>
  );
}
