import type { SeasonGlossarySummary } from "@lexicue/shared";
import { joinWords } from "../../ui/format.js";
import "./SeasonGlossaryPanel.css";

/**
 * The batch summary of spec sections 2.1 and 3.5: the shared style sheet a
 * multi-file upload was translated against. It is the visible proof of the
 * thing a file-at-a-time tool cannot do, so it names the characters, the fixed
 * terms and the register that held across every episode.
 */
export function SeasonGlossaryPanel({
  glossary,
}: {
  glossary: SeasonGlossarySummary;
}): React.JSX.Element {
  return (
    <section className="card season">
      <div className="card-head">
        <h3 className="card-title">Season glossary</h3>
        <span className="muted season-source">
          {glossary.sourceLanguage} · {glossary.register} register
        </span>
      </div>

      <div className="season-body">
        <p className="hint">
          Built from a sample of every file before any of them were translated, then extended by
          each episode in turn, so names and forms of address hold from the first file to the last.
          Sampled {joinWords(glossary.sampledFiles)}.
        </p>

        {glossary.characters.length > 0 ? (
          <div className="season-block">
            <h4 className="eyebrow">Characters</h4>
            <ul className="season-list">
              {glossary.characters.map((character) => (
                <li key={character.name}>
                  <span className="season-term">{character.name}</span>
                  <span aria-hidden="true" className="faint">
                    →
                  </span>
                  <span className="season-rendered">{character.rendered}</span>
                  {character.notes === "" ? null : (
                    <span className="faint season-note">{character.notes}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {glossary.terms.length > 0 ? (
          <div className="season-block">
            <h4 className="eyebrow">Terms</h4>
            <ul className="season-list">
              {glossary.terms.map((term) => (
                <li key={term.source}>
                  <span className="season-term">{term.source}</span>
                  <span aria-hidden="true" className="faint">
                    →
                  </span>
                  <span className="season-rendered">{term.target}</span>
                  {term.notes === "" ? null : (
                    <span className="faint season-note">{term.notes}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {glossary.styleNotes.length > 0 ? (
          <div className="season-block">
            <h4 className="eyebrow">Style</h4>
            <ul className="season-notes">
              {glossary.styleNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
