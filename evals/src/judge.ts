import type { SubtitleDocument } from "@lexicue/subtitles";
import { stripMarkup } from "@lexicue/subtitles";
import type { ModelRequest, ModelUsage, TranslationModelClient } from "@lexicue/harness";
import { emptyUsage } from "@lexicue/harness";
import {
  AXES,
  JUDGE_RUBRIC,
  JudgementSchema,
  RUBRIC_VERSION,
  SeasonConsistencySchema,
  type Axis,
  type Judgement,
  type SeasonConsistency,
} from "./rubric.js";

/**
 * The judge is a more capable model than the one under test, and it is
 * eval-only spend that never runs in the product (spec section 10.4).
 */
export const DEFAULT_JUDGE_MODEL = "claude-opus-5";

export interface JudgeOptions {
  model?: string;
  /** How many cues of each file to score. */
  sampleSize?: number;
  maxTokens?: number;
}

/** A stratified sample: cues spread evenly through the file, never clustered. */
export function stratifiedSample(cueIds: readonly number[], sampleSize: number): number[] {
  if (sampleSize >= cueIds.length) return [...cueIds];
  if (sampleSize < 1) return [];
  const step = cueIds.length / sampleSize;
  const picked: number[] = [];
  for (let index = 0; index < sampleSize; index += 1) {
    const id = cueIds[Math.floor(index * step)];
    if (id !== undefined && !picked.includes(id)) picked.push(id);
  }
  return picked;
}

export interface JudgeResult {
  rubricVersion: string;
  model: string;
  sampledCues: number;
  /** Mean score per axis over the sample, or null when the judge said nothing. */
  means: Record<Axis, number> | null;
  lowest: { id: number; axis: Axis; score: number; note: string }[];
  summary: string;
  usage: ModelUsage;
}

/** Scores a stratified sample of one file's cues against the frozen rubric. */
export async function judgeFile(
  client: TranslationModelClient,
  input: {
    source: SubtitleDocument;
    output: SubtitleDocument;
    targetLanguage: string;
    glossary: string;
    jobId: string;
  },
  options: JudgeOptions = {},
): Promise<JudgeResult> {
  const model = options.model ?? DEFAULT_JUDGE_MODEL;
  const sampleSize = options.sampleSize ?? 20;
  const ids = stratifiedSample(
    input.source.cues.filter((cue) => cue.lines.length > 0).map((cue) => cue.id),
    sampleSize,
  );

  const request: ModelRequest<Judgement> = {
    model,
    maxTokens: options.maxTokens ?? 8000,
    effort: "high",
    system: [{ text: JUDGE_RUBRIC }],
    user: [{ text: renderJudgeRequest(input, ids) }],
    outputSchema: JudgementSchema,
    purpose: "judge",
    jobId: input.jobId,
  };

  const response = await client.complete(request);
  const judgement = response.parsed;
  if (judgement === null) {
    return {
      rubricVersion: RUBRIC_VERSION,
      model,
      sampledCues: ids.length,
      means: null,
      lowest: [],
      summary: "The judge returned nothing that matched the rubric schema.",
      usage: response.usage,
    };
  }

  const means = {} as Record<Axis, number>;
  for (const axis of AXES) {
    const scores = judgement.verdicts.map((verdict) => verdict[axis]);
    means[axis] =
      scores.length === 0
        ? 0
        : Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100;
  }

  const lowest = judgement.verdicts
    .flatMap((verdict) =>
      AXES.map((axis) => ({ id: verdict.i, axis, score: verdict[axis], note: verdict.note })),
    )
    .filter((entry) => entry.score <= 3)
    .sort((left, right) => left.score - right.score)
    .slice(0, 10);

  return {
    rubricVersion: RUBRIC_VERSION,
    model,
    sampledCues: judgement.verdicts.length,
    means,
    lowest,
    summary: judgement.summary,
    usage: response.usage,
  };
}

/** Renders the judge's request: source and translation side by side. */
export function renderJudgeRequest(
  input: {
    source: SubtitleDocument;
    output: SubtitleDocument;
    targetLanguage: string;
    glossary: string;
  },
  ids: readonly number[],
): string {
  const outputById = new Map(input.output.cues.map((cue) => [cue.id, cue]));
  const wanted = new Set(ids);
  const lines: string[] = [
    `Target language: ${input.targetLanguage}.`,
    "",
    input.glossary,
    "",
    `Score these ${ids.length.toString()} cues. Each line is the cue id, the source and the translation, separated by tabs. Lines marked "context" are there for continuity only and must not be scored.`,
    "",
  ];
  for (const cue of input.source.cues) {
    const translated = outputById.get(cue.id);
    if (translated === undefined) continue;
    const label = wanted.has(cue.id) ? cue.id.toString() : "context";
    lines.push(
      `${label}\t${stripMarkup(cue.lines.join(" "))}\t${stripMarkup(translated.lines.join(" "))}`,
    );
  }
  return lines.join("\n");
}

/**
 * The cross-episode consistency check of spec section 10.4: the same name
 * renderings and the same form of address in every episode of a season.
 */
export async function judgeSeasonConsistency(
  client: TranslationModelClient,
  input: { episodes: { file: string; text: string }[]; targetLanguage: string; glossary: string },
  options: JudgeOptions = {},
): Promise<{ result: SeasonConsistency; usage: ModelUsage }> {
  if (input.episodes.length < 2) {
    return { result: { consistent: true, findings: [] }, usage: emptyUsage() };
  }
  const response = await client.complete({
    model: options.model ?? DEFAULT_JUDGE_MODEL,
    maxTokens: options.maxTokens ?? 4000,
    effort: "high",
    system: [{ text: JUDGE_RUBRIC }],
    user: [
      {
        text: [
          `These are ${input.episodes.length.toString()} episodes of one season, translated into ${input.targetLanguage} against a shared glossary.`,
          "",
          input.glossary,
          "",
          "Report anything a viewer watching them in order would notice as an inconsistency: a character's name rendered differently, a recurring term translated two ways, or a pair of characters who switch between formal and informal address without the dialogue marking the change.",
          "",
          ...input.episodes.map((episode) => `--- ${episode.file} ---\n${episode.text}`),
        ].join("\n"),
      },
    ],
    outputSchema: SeasonConsistencySchema,
    purpose: "judge",
    jobId: "season-consistency",
  });
  return {
    result: response.parsed ?? {
      consistent: false,
      findings: ["The judge returned nothing that matched the schema."],
    },
    usage: response.usage,
  };
}

/** One episode of a season, as the structural cross-episode check sees it. */
export interface ConsistencyEpisode {
  file: string;
  /** The episode's source text, which decides whether the term occurs at all. */
  source: string;
  /** The episode's translated text. */
  text: string;
}

/**
 * The structural half of the cross-episode check, which needs no model: every
 * episode was translated against the same glossary, so a name the glossary
 * fixes must be rendered the same way in every episode that actually uses it.
 *
 * The subject of the check is the set of episodes whose *source* contains the
 * term, not every episode of the season. An episode that never names a
 * character cannot render that character inconsistently, and reporting it as
 * one is a false positive: in the season fixture Ivo is never named in episode
 * two's source and Petar never in episode one's, and the run of 14 September
 * 2026 reported both as drift when the translation was correct.
 *
 * A finding therefore needs a disagreement: among the episodes whose source has
 * the term, at least one uses the fixed rendering and at least one does not.
 * That is what a viewer watching in order notices. A term rendered some other
 * way in *every* episode is consistent, and is the judge's nameConsistency axis
 * to catch, not this one's.
 *
 * Containment is plain case-insensitive substring rather than a word boundary,
 * because target languages compound and inflect: "Logbuch" inside
 * "Logbucheintrag" is a real occurrence, and a boundary check would report it
 * as missing.
 */
export function checkNameConsistency(
  episodes: readonly ConsistencyEpisode[],
  renderings: readonly { name: string; rendered: string }[],
): { consistent: boolean; findings: string[] } {
  const findings: string[] = [];
  for (const { name, rendered } of renderings) {
    if (name.trim() === "" || rendered.trim() === "") continue;
    const uses = episodes.filter((episode) => contains(episode.source, name));
    if (uses.length < 2) continue;
    const renderIt = uses.filter((episode) => contains(episode.text, rendered));
    if (renderIt.length === 0 || renderIt.length === uses.length) continue;
    const missing = uses.filter((episode) => !contains(episode.text, rendered));
    findings.push(
      `"${name.trim()}" is in the source of ${uses.map((episode) => episode.file).join(", ")}, but the glossary's rendering "${rendered.trim()}" is used in ${renderIt.map((episode) => episode.file).join(", ")} and not in ${missing.map((episode) => episode.file).join(", ")}`,
    );
  }
  return { consistent: findings.length === 0, findings };
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}
