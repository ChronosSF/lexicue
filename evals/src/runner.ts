import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lane } from "@lexicue/pricing";
import { serialiseSubtitleDocument } from "@lexicue/subtitles";
import {
  PROMPT_VERSION,
  emptyGlossary,
  findTargetLanguage,
  renderGlossary,
  resolveConfig,
  translateUpload,
  type HarnessConfig,
  type ModelUsage,
  type TranslationModelClient,
  type TranslationOptions,
} from "@lexicue/harness";
import { addUsage, emptyUsage } from "@lexicue/harness";
import { loadCorpus, seasonEntries, standaloneEntries, type CorpusEntry } from "./corpus.js";
import {
  checkNameConsistency,
  judgeFile,
  judgeSeasonConsistency,
  type ConsistencyEpisode,
  type JudgeResult,
} from "./judge.js";
import {
  hardMetricsPassed,
  measureFile,
  measureRepeatedLinesAcross,
  previewPrice,
  type FileMetrics,
  type RepeatedLineConsistency,
} from "./metrics.js";
import { RUBRIC_VERSION } from "./rubric.js";

export interface EvalRunOptions {
  client: TranslationModelClient;
  /** Target language codes; defaults to the eight of spec section 10.4. */
  targets: readonly string[];
  lane: Lane;
  config?: Partial<HarnessConfig>;
  /** Skip the LLM judge, for a structure-only run. */
  judge?: boolean;
  judgeModel?: string;
  judgeSampleSize?: number;
  /** Restrict the corpus to files whose path contains this text. */
  only?: string;
  corpusRoot?: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface EvalFileResult {
  metrics: FileMetrics;
  judge: JudgeResult | null;
}

export interface EvalRunResult {
  startedAt: string;
  promptVersion: string;
  rubricVersion: string;
  model: string;
  effort: string;
  lane: Lane;
  targets: string[];
  files: EvalFileResult[];
  seasons: {
    season: string;
    target: string;
    consistent: boolean;
    findings: string[];
    /**
     * Lines the season repeats across its episodes, and how they came back.
     * Advisory, so it never moves `consistent` (spec section 10.4 keeps the
     * cross-episode check on names and forms of address).
     */
    repeatedLines: RepeatedLineConsistency[];
  }[];
  hardMetricsPassed: boolean;
  totals: {
    files: number;
    cues: number;
    dialogueChars: number;
    priceCents: number;
    modelCostUsd: number;
    wallTimeMs: number;
    usage: ModelUsage;
  };
}

/**
 * Runs the eval of spec section 10.4 over the corpus: every file into every
 * target on one lane, the hard and advisory metrics, the LLM judge on a
 * stratified sample, and the cross-episode check on the season.
 */
export async function runEval(options: EvalRunOptions): Promise<EvalRunResult> {
  const log = options.log ?? (() => undefined);
  const config = resolveConfig(options.config ?? {});
  const corpus = loadCorpus(options.corpusRoot).filter(
    (entry) => options.only === undefined || entry.file.path.includes(options.only),
  );
  const usage = emptyUsage();
  const files: EvalFileResult[] = [];
  const seasons: EvalRunResult["seasons"] = [];
  const startedAt = new Date(options.now?.() ?? Date.now()).toISOString();

  for (const code of options.targets) {
    const target = findTargetLanguage(code);
    if (target === undefined) throw new Error(`"${code}" is not a target language.`);
    const translationOptions: TranslationOptions = {
      target,
      lane: options.lane,
      formality: "auto",
      contextNote: "",
      lineHandling: "reflow",
      translateLyrics: true,
    };

    // Standalone files are one upload each; a season is one upload, because the
    // shared glossary is the thing being evaluated.
    const groups: CorpusEntry[][] = standaloneEntries(corpus).map((entry) => [entry]);
    const season = seasonEntries(corpus, "skerry-point");
    if (season.length > 0) groups.push(season);

    for (const group of groups) {
      log(`${code}: ${group.map((entry) => entry.file.title).join(", ")}`);
      const upload = await translateUpload({
        client: options.client,
        config,
        options: translationOptions,
        jobs: group.map((entry) => entry.job),
        collect: { wait: () => Promise.resolve() },
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      addUsage(usage, upload.usage);

      for (const [index, file] of upload.files.entries()) {
        const entry = group[index];
        if (entry === undefined) continue;
        const metrics = measureFile({
          source: entry.job.document,
          outputText: file.text,
          report: file.report,
          previewPriceCents: previewPrice(entry.job.document, options.lane),
          target: code,
          lane: options.lane,
        });
        const judged =
          options.judge === false
            ? null
            : await judgeFile(
                options.client,
                {
                  source: entry.job.document,
                  output: file.document,
                  targetLanguage: target.name,
                  glossary: renderGlossary(file.glossary),
                  jobId: `${entry.job.jobId}-${code}`,
                },
                {
                  ...(options.judgeModel === undefined ? {} : { model: options.judgeModel }),
                  ...(options.judgeSampleSize === undefined
                    ? {}
                    : { sampleSize: options.judgeSampleSize }),
                },
              );
        if (judged !== null) addUsage(usage, judged.usage);
        files.push({ metrics, judge: judged });
      }

      if (group.length > 1 && group[0]?.file.season !== undefined) {
        // The source of each episode goes in alongside the translation: a name
        // that an episode never uses cannot be rendered inconsistently in it.
        const episodes: ConsistencyEpisode[] = upload.files.map((file, index) => {
          const source = group[index]?.job.document;
          return {
            file: file.report.file,
            source: source === undefined ? "" : serialiseSubtitleDocument(source),
            text: serialiseSubtitleDocument(file.document),
          };
        });
        const structural = checkNameConsistency(
          episodes,
          (upload.seasonGlossary?.characters ?? []).map((character) => ({
            name: character.name,
            rendered: character.rendered,
          })),
        );
        const judged =
          options.judge === false
            ? { result: { consistent: true, findings: [] }, usage: emptyUsage() }
            : await judgeSeasonConsistency(options.client, {
                episodes,
                targetLanguage: target.name,
                glossary: renderGlossary(upload.seasonGlossary ?? emptyGlossary()),
              });
        addUsage(usage, judged.usage);
        seasons.push({
          season: group[0].file.season,
          target: code,
          consistent: structural.consistent && judged.result.consistent,
          findings: [...structural.findings, ...judged.result.findings],
          repeatedLines: measureRepeatedLinesAcross(
            upload.files.flatMap((file, index) => {
              const source = group[index]?.job.document;
              return source === undefined ? [] : [{ source, output: file.document }];
            }),
          ),
        });
      }
    }
  }

  const metrics = files.map((file) => file.metrics);
  return {
    startedAt,
    promptVersion: PROMPT_VERSION,
    rubricVersion: RUBRIC_VERSION,
    model: options.client.name === "fake" ? "fake" : config.model,
    effort: config.effort,
    lane: options.lane,
    targets: [...options.targets],
    files,
    seasons,
    hardMetricsPassed: hardMetricsPassed(metrics),
    totals: {
      files: metrics.length,
      cues: metrics.reduce((sum, metric) => sum + metric.advisory.cues, 0),
      dialogueChars: metrics.reduce((sum, metric) => sum + metric.advisory.dialogueChars, 0),
      priceCents: metrics.reduce((sum, metric) => sum + metric.advisory.priceCents, 0),
      modelCostUsd: metrics.reduce((sum, metric) => sum + metric.advisory.modelCostUsd, 0),
      wallTimeMs: metrics.reduce((sum, metric) => sum + metric.advisory.wallTimeMs, 0),
      usage,
    },
  };
}

/**
 * The results directory layout: one folder per run, holding the machine-readable
 * result and a summary a reviewer can read in a pull request (spec section 10.4).
 */
export function writeResults(
  result: EvalRunResult,
  options: { root: string; label?: string },
): string {
  const stamp = result.startedAt.replaceAll(/[:.]/g, "-");
  const directory = join(options.root, `${stamp}-${options.label ?? result.model}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, "summary.md"), summarise(result), "utf8");
  return directory;
}

/** A short Markdown summary, so a regression is visible in review. */
export function summarise(result: EvalRunResult): string {
  const lines: string[] = [
    `# Eval run ${result.startedAt}`,
    "",
    `- Model: ${result.model} at effort ${result.effort}, ${result.lane} lane`,
    `- Prompt: ${result.promptVersion}`,
    `- Rubric: ${result.rubricVersion}`,
    `- Targets: ${result.targets.join(", ")}`,
    `- Hard metrics: ${result.hardMetricsPassed ? "all passed" : "FAILED"}`,
    `- ${result.totals.files.toString()} files, ${result.totals.cues.toLocaleString("en-US")} cues, ${result.totals.dialogueChars.toLocaleString("en-US")} characters`,
    `- Price ${(result.totals.priceCents / 100).toFixed(2)} USD, model cost ${result.totals.modelCostUsd.toFixed(4)} USD`,
    "",
    "| File | Target | Fidelity | Tags | Coverage | Price | Untranslated | Accuracy | Naturalness | Register | Names |",
    "|---|---|---|---|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const file of result.files) {
    const hard = file.metrics.hard;
    const means = file.judge?.means;
    lines.push(
      `| ${file.metrics.file} | ${file.metrics.target} | ${tick(hard.structuralFidelity)} | ${tick(hard.tagPreservation)} | ${tick(hard.coverage)} | ${tick(hard.priceEqualsPreview)} | ${file.metrics.advisory.untranslatedCues.toString()} | ${score(means?.accuracy)} | ${score(means?.naturalness)} | ${score(means?.register)} | ${score(means?.nameConsistency)} |`,
    );
  }
  if (result.seasons.length > 0) {
    lines.push("", "## Cross-episode consistency", "");
    for (const season of result.seasons) {
      lines.push(
        `- ${season.season} into ${season.target}: ${season.consistent ? "consistent" : "inconsistent"}`,
      );
      for (const finding of season.findings) lines.push(`  - ${finding}`);
    }
  }
  lines.push(...summariseRepeatedLines(result));
  const failures = result.files.flatMap((file) => file.metrics.hard.failures);
  if (failures.length > 0) {
    lines.push("", "## Hard metric failures", "");
    for (const failure of failures) lines.push(`- ${failure}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The repeated-line advisory, which is the measurement of what the v4 glossary
 * is for. It says nothing when the corpus repeats nothing, so a reviewer can
 * tell "no drift" apart from "nothing to drift".
 */
function summariseRepeatedLines(result: EvalRunResult): string[] {
  const groups = [
    ...result.files.flatMap((file) =>
      file.metrics.advisory.repeatedLines.map((line) => ({ where: file.metrics.file, line })),
    ),
    ...result.seasons.flatMap((season) =>
      season.repeatedLines.map((line) => ({ where: `${season.season} (across episodes)`, line })),
    ),
  ];
  if (groups.length === 0) return [];
  const drifted = groups.filter((group) => !group.line.consistent);
  const lines = [
    "",
    "## Repeated lines",
    "",
    `- ${groups.length.toString()} repeated lines measured, ${drifted.length.toString()} rendered more than one way`,
  ];
  for (const { where, line } of drifted) {
    lines.push(
      `- **${where}**: "${line.source}" (${line.occurrences.toString()}x) came back as ${line.renderings.map((rendering) => `"${rendering}"`).join(" and ")}`,
    );
  }
  return lines;
}

function tick(passed: boolean): string {
  return passed ? "pass" : "**FAIL**";
}

function score(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(2);
}
