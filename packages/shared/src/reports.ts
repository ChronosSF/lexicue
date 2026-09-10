import { z } from "zod";
import { CentsSchema, LaneSchema, SubtitleFormatSchema } from "./common.js";

/**
 * The report of spec section 3.5, as it crosses the wire. It mirrors
 * `FileReport` in `packages/harness`, which is what produces it; the test in
 * this package asserts a harness report parses cleanly against this schema, so
 * the two cannot drift apart.
 */

export const ModelUsageSchema = z.object({
  inputTokens: z.int(),
  outputTokens: z.int(),
  cacheCreationInputTokens: z.int(),
  cacheReadInputTokens: z.int(),
  cacheCreation5mInputTokens: z.int(),
  cacheCreation1hInputTokens: z.int(),
});

export const CostBreakdownSchema = z.object({
  cacheWriteUsd: z.number(),
  cacheReadUsd: z.number(),
  uncachedInputUsd: z.number(),
  outputUsd: z.number(),
  totalUsd: z.number(),
});

/** A cue the harness could not translate: it keeps its source text (2.3, 3.5). */
export const UntranslatedCueSchema = z.object({
  id: z.int(),
  index: z.string().nullable(),
  timing: z.string(),
  reason: z.string(),
});

/** Advisory: the cue is on screen too briefly for the text it carries. */
export const ReadingSpeedFindingSchema = z.object({
  id: z.int(),
  timing: z.string(),
  charsPerSecond: z.number(),
});

/** Advisory: a line longer than the target language's threshold. */
export const LineLengthFindingSchema = z.object({
  id: z.int(),
  timing: z.string(),
  length: z.int(),
  line: z.string(),
});

export const FileReportSchema = z.object({
  file: z.string(),
  format: z.string(),
  encoding: z.string(),
  bom: z.boolean(),
  lane: LaneSchema,
  targetLanguage: z.string(),
  model: z.string(),
  fallbackModelUsed: z.boolean(),
  promptVersion: z.string(),
  effort: z.string(),
  batchSize: z.int(),
  batches: z.int(),

  totalCues: z.int(),
  translatedCues: z.int(),
  untranslatedCues: z.array(UntranslatedCueSchema),
  glossaryEntriesApplied: z.int(),
  seasonGlossaryApplied: z.boolean(),

  readingSpeedFindings: z.array(ReadingSpeedFindingSchema),
  longLines: z.array(LineLengthFindingSchema),
  repairs: z.array(z.string()),
  warnings: z.array(z.string()),

  dialogueChars: z.int(),
  priceCents: CentsSchema,
  wallTimeMs: z.number(),
  usage: ModelUsageSchema,
  modelCostUsd: z.number(),
  cost: CostBreakdownSchema,
});

/** The season glossary as the batch summary shows it (spec sections 2.1, 3.5). */
export const SeasonGlossarySummarySchema = z.object({
  applied: z.boolean(),
  characters: z.array(z.object({ name: z.string(), rendered: z.string(), notes: z.string() })),
  terms: z.array(z.object({ source: z.string(), target: z.string(), notes: z.string() })),
  styleNotes: z.array(z.string()),
  register: z.string(),
  sourceLanguage: z.string(),
  sampledFiles: z.array(z.string()),
  droppedFiles: z.array(z.string()),
});

/** What the preview table knows about a file before anything is charged (2.1). */
export const FilePreviewSchema = z.object({
  fileName: z.string(),
  format: SubtitleFormatSchema,
  encoding: z.string(),
  bom: z.boolean(),
  cueCount: z.int(),
  dialogueChars: z.int(),
  /** Last cue's end time, which is what "running time" means for a subtitle file. */
  runningTimeMs: z.int(),
  byteLength: z.int(),
  /** The price on each lane, so the picker can show both (spec section 2.1). */
  priceCents: z.record(LaneSchema, CentsSchema),
  warnings: z.array(z.string()),
});

export type ModelUsage = z.infer<typeof ModelUsageSchema>;
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;
export type UntranslatedCue = z.infer<typeof UntranslatedCueSchema>;
export type ReadingSpeedFinding = z.infer<typeof ReadingSpeedFindingSchema>;
export type LineLengthFinding = z.infer<typeof LineLengthFindingSchema>;
export type FileReport = z.infer<typeof FileReportSchema>;
export type SeasonGlossarySummary = z.infer<typeof SeasonGlossarySummarySchema>;
export type FilePreview = z.infer<typeof FilePreviewSchema>;
