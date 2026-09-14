import { formatCents } from "@lexicue/pricing";
import { ApiError, isInsufficientBalance, rateTableOf } from "@lexicue/shared";
import { MAX_FILES_PER_UPLOAD } from "@lexicue/subtitles";
import { useState } from "react";
import { useDraft } from "../../app/draft.js";
import { useCreateBatch, useLanguages, useMe, usePricing, useTopUp } from "../../app/queries.js";
import { useRoute } from "../../app/routes.js";
import { joinWords, pluralise } from "../../ui/format.js";
import { LaneChoice } from "../options/LaneChoice.js";
import { LanguagePicker } from "../options/LanguagePicker.js";
import { OptionsPanel } from "../options/OptionsPanel.js";
import { ConfirmBar, type Shortfall } from "./ConfirmBar.js";
import { Dropzone } from "./Dropzone.js";
import { FileTable } from "./FileTable.js";
import { SampleTray } from "./SampleTray.js";
import "./UploadScreen.css";
import { totalCents, usableFiles } from "./local-files.js";

/**
 * The upload state of spec section 2: drop files, see exactly what the app
 * understood and what it will cost, take out anything unusable, choose a
 * language and a lane, and confirm a price that cannot change afterwards.
 */
export function UploadScreen(): React.JSX.Element {
  const draft = useDraft();
  const { navigate } = useRoute();
  const me = useMe();
  const pricing = usePricing();
  const languages = useLanguages();
  const createBatch = useCreateBatch();
  const topUp = useTopUp();
  const [failure, setFailure] = useState<ApiError | null>(null);

  const usable = usableFiles(draft.files);
  const problems = draft.files.length - usable.length;
  // The rates the API served, which is what the server will charge with; until
  // the route answers, today's published defaults.
  const rates = rateTableOf(pricing.data?.rates ?? []);
  const totals = {
    fast: totalCents(usable, "fast", rates),
    economy: totalCents(usable, "economy", rates),
  };
  const total = totals[draft.lane];
  const balanceCents = me.data?.balanceCents ?? 0;

  const shortfall: Shortfall | null =
    usable.length > 0 && balanceCents < total
      ? {
          shortfallCents: total - balanceCents,
          suggestedTopUpCents: smallestTopUpFor(
            total - balanceCents,
            pricing.data?.topUpAmountsCents ?? [500, 1000, 2500],
          ),
        }
      : failureShortfall(failure);

  const blockedBecause =
    usable.length === 0
      ? "Add a subtitle file to begin."
      : draft.targetLanguage === null
        ? "Choose a target language."
        : null;

  const translate = (): void => {
    if (draft.targetLanguage === null) return;
    setFailure(null);
    createBatch.mutate(
      {
        files: usable.map((file) => ({ fileName: file.fileName, bytes: file.bytes })),
        targetLanguage: draft.targetLanguage,
        lane: draft.lane,
        options: draft.options,
      },
      {
        onSuccess: (batch) => {
          draft.clear();
          navigate({ name: "batch", batchId: batch.batchId });
        },
        onError: (error) => {
          if (error instanceof ApiError) setFailure(error);
        },
      },
    );
  };

  const startTopUp = (amountCents: number): void => {
    topUp.mutate(
      { amountCents },
      {
        onSuccess: (session) => {
          navigate(session.checkoutUrl);
        },
      },
    );
  };

  return (
    <div className="upload stack-lg">
      {draft.files.length === 0 ? (
        <section className="hero stack">
          <h1>Translate a subtitle file, or a whole season.</h1>
          <p className="hero-lead">
            Every cue index, timecode, positioning tag and formatting tag comes back exactly as it
            went in. Only the spoken text changes. You see the price of every file before anything
            is charged.
          </p>
        </section>
      ) : null}

      <Dropzone onFiles={draft.addFiles} compact={draft.files.length > 0} />

      {draft.files.length === 0 ? (
        <SampleTray onFiles={draft.addFiles} />
      ) : (
        <>
          <details className="upload-samples">
            <summary>Add another sample file</summary>
            <SampleTray onFiles={draft.addFiles} />
          </details>

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
                {formatCents(totals.fast)} fast · {formatCents(totals.economy)} economy
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  draft.clear();
                  setFailure(null);
                }}
              >
                Start again
              </button>
            </div>

            <FileTable
              files={draft.files}
              lane={draft.lane}
              rates={rates}
              onRemove={draft.removeFile}
            />

            {draft.files.length >= MAX_FILES_PER_UPLOAD ? (
              <p className="hint">
                An upload carries {MAX_FILES_PER_UPLOAD} files at a time; the rest go in a second
                upload.
              </p>
            ) : null}

            {draft.ignored.length > 0 ? (
              <p className="hint">
                Ignored {joinWords(draft.ignored.slice(0, 4))}
                {draft.ignored.length > 4
                  ? ` and ${(draft.ignored.length - 4).toString()} more`
                  : ""}
                : only SubRip and the two .sub dialects can be translated.
              </p>
            ) : null}
          </section>

          <section className="card card-pad choices">
            <div className="choices-column">
              <LanguagePicker
                languages={languages.data?.languages ?? []}
                value={draft.targetLanguage}
                onChange={draft.setTargetLanguage}
              />
              <LaneChoice
                rates={pricing.data?.rates ?? []}
                value={draft.lane}
                totals={totals}
                onChange={draft.setLane}
              />
            </div>
            <div className="choices-column">
              <OptionsPanel options={draft.options} onChange={draft.setOptions} />
            </div>
          </section>

          {failure !== null && !isInsufficientBalance(failure) ? (
            <UploadFailure error={failure} />
          ) : null}

          <ConfirmBar
            fileCount={usable.length}
            totalCents={total}
            balanceCents={balanceCents}
            shortfall={shortfall}
            blockedBecause={blockedBecause}
            pending={createBatch.isPending || topUp.isPending}
            error={
              shortfall === null
                ? null
                : `Your balance is ${formatCents(balanceCents)}, which is ${formatCents(
                    shortfall.shortfallCents,
                  )} short of this upload.`
            }
            onTranslate={translate}
            onTopUp={startTopUp}
          />
        </>
      )}
    </div>
  );
}

/** The 422s of spec section 7.3, as the sentences they carry. */
function UploadFailure({ error }: { error: ApiError }): React.JSX.Element {
  return (
    <section className="card card-pad upload-failure">
      <p className="problem">{error.message}</p>
      {error.is("unusable-files") ? (
        <ul className="upload-failure-list">
          {error.body.files.map((file) => (
            <li key={file.fileName}>
              <strong>{file.fileName}</strong> {file.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function failureShortfall(error: ApiError | null): Shortfall | null {
  if (error === null || !isInsufficientBalance(error)) return null;
  return {
    shortfallCents: error.body.shortfallCents,
    suggestedTopUpCents: error.body.suggestedTopUpCents,
  };
}

function smallestTopUpFor(shortfallCents: number, amounts: readonly number[]): number {
  const sorted = [...amounts].sort((a, b) => a - b);
  return sorted.find((amount) => amount >= shortfallCents) ?? sorted.at(-1) ?? 0;
}
