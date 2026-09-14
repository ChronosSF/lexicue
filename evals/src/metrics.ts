import {
  DEFAULT_RATE_TABLE,
  meteredOf,
  priceCents,
  type Lane,
  type RateTable,
} from "@lexicue/pricing";
import {
  markupMultisetsEqual,
  parseSubtitleText,
  stripMarkup,
  type SubtitleDocument,
} from "@lexicue/subtitles";
import {
  findRepeatedLines,
  findRepeatedLinesAcross,
  repeatKey,
  type FileReport,
  type ModelUsage,
} from "@lexicue/harness";

/**
 * The metrics that must be perfect (spec section 10.4). Any false here is a
 * failed eval run, not a lower score.
 */
export interface HardMetrics {
  structuralFidelity: boolean;
  tagPreservation: boolean;
  coverage: boolean;
  priceEqualsPreview: boolean;
  /** What went wrong, for the results file. */
  failures: string[];
}

/**
 * How one line that the source repeats word for word came back. Advisory, never
 * a hard failure: a repeated line rendered two ways is a quality fault a reader
 * should see, not a structural break, and a source that repeats a line inside a
 * longer sentence can legitimately vary.
 */
export interface RepeatedLineConsistency {
  /** The source text, from its first occurrence. */
  source: string;
  occurrences: number;
  /** The distinct renderings that came back, most frequent first. */
  renderings: string[];
  consistent: boolean;
}

/** The metrics that describe a run without passing or failing it. */
export interface AdvisoryMetrics {
  cues: number;
  dialogueChars: number;
  untranslatedCues: number;
  readingSpeedFlagsPerThousandCues: number;
  longLineFlagsPerThousandCues: number;
  repairs: number;
  /** Every line the source repeats, and whether the translation repeated it. */
  repeatedLines: RepeatedLineConsistency[];
  /** Repeated lines that came back with more than one rendering. */
  inconsistentRepeatedLines: number;
  wallTimeMs: number;
  usage: ModelUsage;
  modelCostUsd: number;
  priceCents: number;
  /** Share of prefix tokens served from the cache rather than written to it. */
  cacheReadShare: number;
}

export interface FileMetrics {
  file: string;
  target: string;
  lane: Lane;
  hard: HardMetrics;
  advisory: AdvisoryMetrics;
}

export interface MeasureInput {
  source: SubtitleDocument;
  outputText: string;
  report: FileReport;
  /** The price the preview showed, computed before the run from the source. */
  previewPriceCents: number;
  target: string;
  lane: Lane;
}

/** Measures one translated file against its source. */
export function measureFile(input: MeasureInput): FileMetrics {
  const { source, report } = input;
  const failures: string[] = [];

  let output: SubtitleDocument | null = null;
  try {
    output = parseSubtitleText(input.outputText, { format: source.format });
  } catch (error) {
    failures.push(
      `the output did not parse: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  const coverage = output !== null && output.cues.length === source.cues.length;
  if (!coverage) {
    failures.push(
      `cue count changed from ${source.cues.length.toString()} to ${(output?.cues.length ?? 0).toString()}`,
    );
  }

  let structuralFidelity = output !== null && coverage;
  let tagPreservation = output !== null;
  if (output !== null && coverage) {
    for (const [index, sourceCue] of source.cues.entries()) {
      const outputCue = output.cues[index];
      if (outputCue === undefined) continue;
      if (
        sourceCue.rawIndexLine !== outputCue.rawIndexLine ||
        sourceCue.rawTimingLine !== outputCue.rawTimingLine
      ) {
        structuralFidelity = false;
        failures.push(`cue ${sourceCue.id.toString()} lost its index or timing line`);
      }
      if (!markupMultisetsEqual(sourceCue.lines.join(" "), outputCue.lines.join(" "))) {
        tagPreservation = false;
        failures.push(`cue ${sourceCue.id.toString()} lost or gained a tag`);
      }
    }
  }

  const priceEqualsPreview = report.priceCents === input.previewPriceCents;
  if (!priceEqualsPreview) {
    failures.push(
      `the price charged (${report.priceCents.toString()}) is not the price previewed (${input.previewPriceCents.toString()})`,
    );
  }

  const perThousand = (count: number): number =>
    source.cues.length === 0 ? 0 : Math.round((count / source.cues.length) * 1000 * 10) / 10;

  const cacheDenominator =
    report.usage.cacheReadInputTokens + report.usage.cacheCreationInputTokens;

  const repeatedLines = output === null ? [] : measureRepeatedLines(source, output);

  return {
    file: report.file,
    target: input.target,
    lane: input.lane,
    hard: {
      structuralFidelity,
      tagPreservation,
      coverage,
      priceEqualsPreview,
      failures,
    },
    advisory: {
      cues: source.cues.length,
      dialogueChars: source.dialogueChars,
      untranslatedCues: report.untranslatedCues.length,
      readingSpeedFlagsPerThousandCues: perThousand(report.readingSpeedFindings.length),
      longLineFlagsPerThousandCues: perThousand(report.longLines.length),
      repairs: report.repairs.length,
      repeatedLines,
      inconsistentRepeatedLines: repeatedLines.filter((line) => !line.consistent).length,
      wallTimeMs: report.wallTimeMs,
      usage: report.usage,
      modelCostUsd: report.modelCostUsd,
      priceCents: report.priceCents,
      cacheReadShare:
        cacheDenominator === 0
          ? 0
          : Math.round((report.usage.cacheReadInputTokens / cacheDenominator) * 1000) / 1000,
    },
  };
}

/**
 * Whether a line the source repeats word for word came back the same way every
 * time. This is the measurement of the fault the v4 glossary fixes: the 400-cue
 * fixture says "The line doesn't care." nine times, across four batches that
 * run in parallel, and nothing but a rendering fixed before any of them runs
 * can keep the nine the same.
 *
 * Cues are matched by id, so a file whose coverage failed contributes nothing
 * here rather than nonsense.
 */
export function measureRepeatedLines(
  source: SubtitleDocument,
  output: SubtitleDocument,
): RepeatedLineConsistency[] {
  const outputById = new Map(output.cues.map((cue) => [cue.id, cue]));
  const groups = findRepeatedLines(source.cues.map((cue) => ({ id: cue.id, lines: cue.lines })));
  return groups.map((group) => {
    const counts = new Map<string, number>();
    for (const id of group.ids) {
      const translated = outputById.get(id);
      if (translated === undefined) continue;
      const key = renderingKey(translated.lines);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const renderings = [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
      .map(([text]) => text);
    return {
      source: group.text,
      occurrences: group.occurrences,
      renderings,
      consistent: renderings.length <= 1,
    };
  });
}

/**
 * The same measurement across the files of one upload: a catchphrase a season
 * says once an episode never repeats inside any file, so it is invisible to
 * {@link measureRepeatedLines} and only the season glossary can fix it.
 *
 * Advisory like its per-file twin, and reported beside the cross-episode check
 * rather than inside it: a drifting catchphrase is a quality fault, and the
 * season's consistent-or-not verdict stays about names and forms of address.
 */
export function measureRepeatedLinesAcross(
  files: readonly { source: SubtitleDocument; output: SubtitleDocument }[],
): RepeatedLineConsistency[] {
  const groups = findRepeatedLinesAcross(
    files.map((file) => file.source.cues.map((cue) => ({ id: cue.id, lines: cue.lines }))),
  );
  return groups.map((group) => {
    const key = repeatKey(group.text);
    const renderings = new Set<string>();
    for (const file of files) {
      const outputById = new Map(file.output.cues.map((cue) => [cue.id, cue]));
      for (const cue of file.source.cues) {
        if (repeatKey(cue.lines.join(" ")) !== key) continue;
        const translated = outputById.get(cue.id);
        if (translated === undefined) continue;
        renderings.add(renderingKey(translated.lines));
      }
    }
    return {
      source: group.text,
      occurrences: group.occurrences,
      renderings: [...renderings].sort(),
      consistent: renderings.size <= 1,
    };
  });
}

/**
 * How two renderings of the same repeated line are compared: the words, with
 * markup off.
 *
 * The 400-cue fixture says "The line doesn't care." nine times, three of them
 * inside `<i>` tags and six not. Tag preservation is a hard metric, so those
 * three *must* come back italic and the other six must not — comparing the
 * rendered text with its tags would report the file's own motif as drift on
 * every run that was in fact perfect. What matters here is whether the line was
 * said the same way; whether it was said in italics is the validator's business.
 *
 * Case and punctuation are kept, because "FOLGE EINS" against "Folge eins" is a
 * difference a viewer sees.
 */
function renderingKey(lines: readonly string[]): string {
  return stripMarkup(lines.join(" ")).replaceAll(/\s+/gu, " ").trim();
}

/** The price a preview would have shown, from the parsed source alone. */
export function previewPrice(
  source: SubtitleDocument,
  lane: Lane,
  rates: RateTable = DEFAULT_RATE_TABLE,
): number {
  return priceCents(meteredOf(source), lane, rates);
}

/** True when every hard metric passed. */
export function hardMetricsPassed(metrics: readonly FileMetrics[]): boolean {
  return metrics.every(
    (metric) =>
      metric.hard.structuralFidelity &&
      metric.hard.tagPreservation &&
      metric.hard.coverage &&
      metric.hard.priceEqualsPreview,
  );
}
