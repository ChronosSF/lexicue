import { priceCents, type Lane } from "@lexicue/pricing";
import { markupMultisetsEqual, parseSubtitleText, type SubtitleDocument } from "@lexicue/subtitles";
import type { FileReport, ModelUsage } from "@lexicue/harness";

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

/** The metrics that describe a run without passing or failing it. */
export interface AdvisoryMetrics {
  cues: number;
  dialogueChars: number;
  untranslatedCues: number;
  readingSpeedFlagsPerThousandCues: number;
  longLineFlagsPerThousandCues: number;
  repairs: number;
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

/** The price a preview would have shown, from the parsed source alone. */
export function previewPrice(source: SubtitleDocument, lane: Lane): number {
  return priceCents(source.dialogueChars, lane);
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
