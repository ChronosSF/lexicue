import type { HarnessConfig } from "./config.js";
import type { ModelUsage, TranslationModelClient } from "./model-client.js";
import { renderSourceDocument } from "./prompts/render.js";
import { findRepeatedLinesAcross, type RepeatedLine } from "./repeats.js";
import { buildSeasonGlossaryRequest, type RequestContext } from "./requests.js";
import type { SeasonGlossary } from "./schemas.js";
import { toProtocolCue, type TranslationJob } from "./types.js";
import { withTransportRetry } from "./transport.js";

export interface SeasonSample {
  /** The text handed to the season glossary pass. */
  text: string;
  /** File names that fitted inside the token cap, in order. */
  includedFiles: string[];
  /** File names that were left out because the cap was reached. */
  droppedFiles: string[];
  tokens: number;
}

/**
 * Builds the sample of spec section 4.4: the first 150 cues of every file in
 * the upload, capped at 40,000 tokens in total.
 *
 * The token count comes from the client — for the real client that is the API's
 * own free `count_tokens` endpoint, never a third-party tokenizer, because
 * Claude's tokenizer differs from others by 15 to 30% on non-English text
 * (spec section 4.9).
 */
export async function buildSeasonSample(
  client: TranslationModelClient,
  config: HarnessConfig,
  jobs: readonly TranslationJob[],
): Promise<SeasonSample> {
  const includedFiles: string[] = [];
  const droppedFiles: string[] = [];
  const parts: string[] = [];
  let tokens = 0;

  for (const job of jobs) {
    const cues = job.document.cues.slice(0, config.seasonSampleCues).map(toProtocolCue);
    const part = `## ${job.fileName}\n${renderSourceDocument(cues)}`;
    const partTokens = await client.countTokens({
      model: config.model,
      system: [],
      user: [{ text: part }],
    });
    if (tokens + partTokens > config.seasonSampleTokenCap && includedFiles.length > 0) {
      droppedFiles.push(job.fileName);
      continue;
    }
    parts.push(part);
    includedFiles.push(job.fileName);
    tokens += partTokens;
  }

  return { text: parts.join("\n\n"), includedFiles, droppedFiles, tokens };
}

export interface SeasonGlossaryResult {
  glossary: SeasonGlossary | null;
  sample: SeasonSample;
  /** The lines that repeat across the upload, which this pass fixed a rendering for. */
  repeatedLines: RepeatedLine[];
  usage: ModelUsage;
}

/**
 * The one call per multi-file upload that produces the shared style sheet
 * (spec section 4.4). It runs before any file is translated, and its result is
 * passed into every file's own glossary pass.
 */
export async function runSeasonGlossaryPass(
  client: TranslationModelClient,
  context: RequestContext,
  jobs: readonly TranslationJob[],
): Promise<SeasonGlossaryResult> {
  const sample = await buildSeasonSample(client, context.config, jobs);
  // Repeats are counted over every cue of every file, not over the sample:
  // a catchphrase said once an episode repeats across the set without
  // repeating inside any one file, and this is the only pass that sees the set.
  const repeatedLines = findRepeatedLinesAcross(
    jobs.map((job) => job.document.cues.map(toProtocolCue)),
  );
  const request = buildSeasonGlossaryRequest(context, sample.text, repeatedLines);
  const response = await withTransportRetry(client, context.config, () => client.complete(request));
  return { glossary: response.parsed, sample, repeatedLines, usage: response.usage };
}
