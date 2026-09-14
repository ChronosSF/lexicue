import type { ModelUsage, TranslationModelClient } from "./model-client.js";
import type { RepeatedLine } from "./repeats.js";
import { buildGlossaryRequest, type RequestContext } from "./requests.js";
import { emptyGlossary, type FileGlossary, type SeasonGlossary } from "./schemas.js";
import { withTransportRetry } from "./transport.js";

export interface GlossaryPassResult {
  glossary: FileGlossary;
  usage: ModelUsage;
  /** True when the model produced nothing usable and an empty glossary is in use. */
  degraded: boolean;
}

/**
 * The one glossary call per file (spec section 4.4). It detects the source
 * language, fixes the names and register every batch will share, and warms the
 * cache the batches read.
 *
 * A file glossary may extend the season glossary but never contradict it, which
 * `mergeGlossaries` enforces structurally rather than by asking the model
 * nicely.
 */
export async function runGlossaryPass(
  client: TranslationModelClient,
  context: RequestContext,
  seasonGlossary: SeasonGlossary | null,
  repeatedLines: readonly RepeatedLine[] = [],
): Promise<GlossaryPassResult> {
  const request = buildGlossaryRequest(context, seasonGlossary, repeatedLines);
  const response = await withTransportRetry(client, context.config, () => client.complete(request));
  const parsed = response.parsed;
  if (parsed === null) {
    // A file still completes without a glossary; it just loses the shared
    // decisions about names and register.
    return {
      glossary: mergeGlossaries(
        seasonGlossary,
        emptyGlossary(seasonGlossary?.sourceLanguage ?? ""),
      ),
      usage: response.usage,
      degraded: true,
    };
  }
  return {
    glossary: mergeGlossaries(seasonGlossary, parsed),
    usage: response.usage,
    degraded: false,
  };
}

/**
 * Merges a file's glossary into the season's. Where both name the same
 * character or term, the season's rendering wins; anything the season does not
 * cover is added. This is what makes "may extend, may not contradict" a
 * property of the code rather than of the model's compliance.
 */
export function mergeGlossaries(season: SeasonGlossary | null, file: FileGlossary): FileGlossary {
  if (season === null) return file;
  return {
    sourceLanguage:
      season.sourceLanguage.trim() === "" ? file.sourceLanguage : season.sourceLanguage,
    register: season.register,
    characters: mergeBy(season.characters, file.characters, (character) => character.name),
    terms: mergeBy(season.terms, file.terms, (term) => term.source),
    // A line the season fixed keeps the season's rendering in every episode,
    // which is the whole point of fixing it; a line that repeats only inside
    // this file is added.
    repeatedLines: mergeBy(season.repeatedLines, file.repeatedLines, (line) => line.source),
    // Same for a card: the season's pattern is what keeps episode one's title
    // card the same shape as episode three's.
    cardPatterns: mergeBy(season.cardPatterns, file.cardPatterns, (card) => card.source),
    styleNotes: [
      ...season.styleNotes,
      ...file.styleNotes.filter((note) => !season.styleNotes.includes(note)),
    ],
  };
}

/** True when the file glossary tried to change something the season had fixed. */
export function findContradictions(season: SeasonGlossary, file: FileGlossary): string[] {
  const problems: string[] = [];
  for (const character of file.characters) {
    const fixed = season.characters.find((entry) => sameKey(entry.name, character.name));
    if (fixed !== undefined && fixed.rendered !== character.rendered) {
      problems.push(
        `the file glossary renders ${character.name} as "${character.rendered}" but the season glossary fixes "${fixed.rendered}"`,
      );
    }
  }
  for (const term of file.terms) {
    const fixed = season.terms.find((entry) => sameKey(entry.source, term.source));
    if (fixed !== undefined && fixed.target !== term.target) {
      problems.push(
        `the file glossary translates "${term.source}" as "${term.target}" but the season glossary fixes "${fixed.target}"`,
      );
    }
  }
  for (const line of file.repeatedLines) {
    const fixed = season.repeatedLines.find((entry) => sameKey(entry.source, line.source));
    if (fixed !== undefined && fixed.target !== line.target) {
      problems.push(
        `the file glossary renders the repeated line "${line.source}" as "${line.target}" but the season glossary fixes "${fixed.target}"`,
      );
    }
  }
  for (const card of file.cardPatterns) {
    const fixed = season.cardPatterns.find((entry) => sameKey(entry.source, card.source));
    if (fixed !== undefined && fixed.target !== card.target) {
      problems.push(
        `the file glossary renders the card "${card.source}" as "${card.target}" but the season glossary fixes "${fixed.target}"`,
      );
    }
  }
  if (file.register !== season.register) {
    problems.push(
      `the file glossary calls the register ${file.register} but the season glossary fixes ${season.register}`,
    );
  }
  return problems;
}

function mergeBy<T>(fixed: readonly T[], extra: readonly T[], key: (entry: T) => string): T[] {
  const merged = [...fixed];
  const seen = new Set(fixed.map((entry) => key(entry).trim().toLowerCase()));
  for (const entry of extra) {
    const entryKey = key(entry).trim().toLowerCase();
    if (entryKey === "" || seen.has(entryKey)) continue;
    seen.add(entryKey);
    merged.push(entry);
  }
  return merged;
}

function sameKey(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
