import { priceCents, type Lane } from "@lexicue/pricing";
import { cueDialogueChars, stripMarkup, type SubtitleDocument } from "@lexicue/subtitles";
import type { HarnessConfig } from "./config.js";
import { costBreakdown, modelCostUsd, type CostBreakdown } from "./cost.js";
import type { TargetLanguage } from "./languages.js";
import type { ModelUsage } from "./model-client.js";

/** A cue the harness could not translate, listed for the user (spec 3.5). */
export interface UntranslatedCue {
  id: number;
  index: string | null;
  timing: string;
  reason: string;
}

/** A cue that would be on screen too briefly for its text (spec 3.5). */
export interface ReadingSpeedFinding {
  id: number;
  timing: string;
  charsPerSecond: number;
}

/** A line longer than the target's threshold (spec 3.5). */
export interface LineLengthFinding {
  id: number;
  timing: string;
  length: number;
  line: string;
}

/**
 * The compact JSON report every finished file produces (spec section 3.5).
 * Reading-speed and line-length findings are advisory: they are the yardsticks
 * subtitle editors use, and they tell the user where a hand edit may be worth it.
 */
export interface FileReport {
  file: string;
  format: string;
  encoding: string;
  bom: boolean;
  lane: Lane;
  targetLanguage: string;
  model: string;
  fallbackModelUsed: boolean;
  promptVersion: string;
  effort: string;
  batchSize: number;
  batches: number;

  totalCues: number;
  translatedCues: number;
  untranslatedCues: UntranslatedCue[];
  glossaryEntriesApplied: number;
  seasonGlossaryApplied: boolean;

  readingSpeedFindings: ReadingSpeedFinding[];
  longLines: LineLengthFinding[];
  repairs: string[];
  warnings: string[];

  dialogueChars: number;
  priceCents: number;
  wallTimeMs: number;
  usage: ModelUsage;
  modelCostUsd: number;
  cost: CostBreakdown;
}

export interface BuildReportInput {
  file: string;
  source: SubtitleDocument;
  output: SubtitleDocument;
  untranslated: UntranslatedCue[];
  glossaryEntriesApplied: number;
  seasonGlossaryApplied: boolean;
  repairs: string[];
  warnings: string[];
  usage: ModelUsage;
  wallTimeMs: number;
  batches: number;
  model: string;
  fallbackModelUsed: boolean;
  promptVersion: string;
  lane: Lane;
  target: TargetLanguage;
  config: HarnessConfig;
}

export function buildFileReport(input: BuildReportInput): FileReport {
  const { output, source, config, target } = input;
  const readingSpeedFindings: ReadingSpeedFinding[] = [];
  const longLines: LineLengthFinding[] = [];

  for (const cue of output.cues) {
    const seconds = (cue.endMs - cue.startMs) / 1000;
    const characters = cueDialogueChars(cue);
    if (seconds > 0 && characters > 0) {
      const charsPerSecond = characters / seconds;
      if (charsPerSecond > config.readingSpeedCharsPerSecond) {
        readingSpeedFindings.push({
          id: cue.id,
          timing: cue.rawTimingLine,
          charsPerSecond: Math.round(charsPerSecond * 10) / 10,
        });
      }
    }
    // Line-length thresholds are a Latin-script yardstick; per-language values
    // live in configuration (spec section 3.5).
    if (target.script !== "latin") continue;
    for (const line of cue.lines) {
      const length = Array.from(stripMarkup(line)).length;
      if (length > config.maxLineLength) {
        longLines.push({ id: cue.id, timing: cue.rawTimingLine, length, line });
      }
    }
  }

  return {
    file: input.file,
    format: source.format,
    encoding: source.encoding,
    bom: source.bom,
    lane: input.lane,
    targetLanguage: target.code,
    model: input.model,
    fallbackModelUsed: input.fallbackModelUsed,
    promptVersion: input.promptVersion,
    effort: config.effort,
    batchSize: config.batchSize,
    batches: input.batches,

    totalCues: source.cues.length,
    translatedCues: source.cues.length - input.untranslated.length,
    untranslatedCues: input.untranslated,
    glossaryEntriesApplied: input.glossaryEntriesApplied,
    seasonGlossaryApplied: input.seasonGlossaryApplied,

    readingSpeedFindings,
    longLines,
    repairs: input.repairs,
    warnings: input.warnings,

    dialogueChars: source.dialogueChars,
    priceCents: priceCents(source.dialogueChars, input.lane),
    wallTimeMs: input.wallTimeMs,
    usage: input.usage,
    modelCostUsd: modelCostUsd(input.usage, input.model, input.lane),
    cost: costBreakdown(input.usage, input.model, input.lane),
  };
}

/** The batch summary a multi-file upload adds (spec section 3.5). */
export interface UploadReport {
  files: FileReport[];
  totalCues: number;
  totalDialogueChars: number;
  totalPriceCents: number;
  totalModelCostUsd: number;
  seasonGlossary: {
    applied: boolean;
    characters: number;
    terms: number;
    styleNotes: number;
    sampledFiles: string[];
    droppedFiles: string[];
  } | null;
}
