import {
  FakeTranslationModelClient,
  resolveConfig,
  translateUpload,
  type TargetLanguage,
  type TranslatedFile,
  type TranslationJob,
  type TranslationOptions as HarnessOptions,
} from "@lexicue/harness";
import { serialiseSubtitleDocument, type SubtitleDocument } from "@lexicue/subtitles";
import type { SeasonGlossarySummary, TranslationOptions } from "@lexicue/shared";

/**
 * The mock backend's translation step. It is the real harness — season
 * glossary, batches, validation, retries, reassembly and the final re-parse —
 * driven by the deterministic fake model client of spec section 10.2, which
 * wraps dialogue in guillemets and touches nothing else. The downloaded file is
 * therefore structurally identical to the source: same cue count, same indices,
 * same timing lines, byte for byte.
 */

export interface MockTranslationResult {
  files: TranslatedFile[];
  seasonGlossary: SeasonGlossarySummary | null;
}

export function harnessOptions(
  options: TranslationOptions,
  target: TargetLanguage,
  lane: "fast" | "economy",
): HarnessOptions {
  return {
    target,
    lane,
    formality: options.formality,
    contextNote: options.contextNote,
    lineHandling: options.lineHandling,
    translateLyrics: options.translateLyrics,
  };
}

/**
 * Runs the whole upload through the harness. The economy lane really does go
 * through the fake client's Message Batch API — submit, poll, stream results
 * back out of order — so the code path the demo exercises is the one spec
 * section 4.5 describes, only without the hour of waiting.
 */
export async function runFakeTranslation(input: {
  jobs: { jobId: string; fileName: string; document: SubtitleDocument }[];
  options: HarnessOptions;
}): Promise<MockTranslationResult> {
  const client = new FakeTranslationModelClient();
  const config = resolveConfig({ economyPollIntervalMs: 0, economyMaxWaitMs: 1_000 });
  const jobs: TranslationJob[] = input.jobs.map((job) => ({
    jobId: job.jobId,
    fileName: job.fileName,
    document: job.document,
  }));

  const upload = await translateUpload({
    client,
    config,
    options: input.options,
    jobs,
    collect: { wait: () => Promise.resolve(), pollIntervalMs: 0 },
  });

  const summary = upload.report.seasonGlossary;
  const glossary = upload.seasonGlossary;

  return {
    files: upload.files,
    seasonGlossary:
      summary === null || glossary === null
        ? null
        : {
            applied: summary.applied,
            characters: glossary.characters,
            terms: glossary.terms,
            styleNotes: glossary.styleNotes,
            register: glossary.register,
            sourceLanguage: glossary.sourceLanguage,
            sampledFiles: summary.sampledFiles,
            droppedFiles: summary.droppedFiles,
          },
  };
}

/** The output file name of spec section 2.1: `original-name.de.srt`. */
export function outputFileName(fileName: string, languageCode: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName}.${languageCode}`;
  return `${fileName.slice(0, dot)}.${languageCode}${fileName.slice(dot)}`;
}

/** The bytes a download hands over: UTF-8, with the byte-order mark by default. */
export function outputBytes(text: string, bom: boolean): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  if (!bom) return encoded;
  const withMark = new Uint8Array(encoded.length + 3);
  withMark.set([0xef, 0xbb, 0xbf], 0);
  withMark.set(encoded, 3);
  return withMark;
}

/** The text of a document, for a file the harness has already verified. */
export function documentText(document: SubtitleDocument): string {
  return serialiseSubtitleDocument(document);
}

/** Running time is where the last cue ends (spec section 2.1). */
export function runningTimeMs(document: SubtitleDocument): number {
  return document.cues.reduce((longest, cue) => Math.max(longest, cue.endMs), 0);
}
