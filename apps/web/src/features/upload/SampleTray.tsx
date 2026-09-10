import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useBackend } from "../../app/backend.js";
import { formatName, pluralise } from "../../ui/format.js";
import "./SampleTray.css";
import type { RawFile } from "./local-files.js";

/**
 * The demo's sample files: the evaluation corpus of spec section 10.4, so
 * nobody has to go and find a subtitle file before they can try the product.
 * They are real files, including the two `.sub` dialects, a German and a
 * Spanish source, a hearing-impaired edition, a three-episode season, and one
 * that fails on purpose.
 */
export function SampleTray({
  onFiles,
}: {
  onFiles: (files: RawFile[]) => void;
}): React.JSX.Element | null {
  const backend = useBackend();
  const [loading, setLoading] = useState<string | null>(null);

  const samples = useQuery({
    queryKey: ["samples"],
    queryFn: () => backend.demo?.listSamples() ?? Promise.resolve([]),
    enabled: backend.demo !== null,
    staleTime: Infinity,
  });

  if (backend.demo === null || samples.data === undefined || samples.data.length === 0) return null;

  const load = (paths: string[], key: string): void => {
    const demo = backend.demo;
    if (demo === null) return;
    setLoading(key);
    void Promise.all(paths.map((path) => demo.loadSample(path)))
      .then((loaded) => {
        onFiles(loaded.map((file) => ({ name: file.fileName, bytes: file.bytes })));
      })
      .finally(() => {
        setLoading(null);
      });
  };

  const season = samples.data.filter((sample) => sample.path.startsWith("season/"));

  return (
    <section className="samples">
      <div className="samples-head">
        <h2 className="eyebrow">Sample files</h2>
        {season.length > 1 ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading !== null}
            onClick={() => {
              load(
                season.map((sample) => sample.path),
                "season",
              );
            }}
          >
            Add all {season.length} episodes
          </button>
        ) : null}
      </div>

      <ul className="samples-list">
        {samples.data.map((sample) => (
          <li key={sample.path}>
            <button
              type="button"
              className={sample.fails === true ? "sample is-failure" : "sample"}
              disabled={loading !== null}
              onClick={() => {
                load([sample.path], sample.path);
              }}
            >
              <span className="sample-title">{sample.title}</span>
              <span className="sample-meta muted">
                {formatName(sample.format)} · {pluralise(sample.cues, "cue")} ·{" "}
                {sample.sourceLanguage.toUpperCase()}
              </span>
              <span className="sample-description faint">{sample.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
