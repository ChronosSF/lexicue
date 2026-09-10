import type { ModelUsage, TranslationModelClient } from "./model-client.js";
import { buildGlossaryRequest, type RequestContext } from "./requests.js";
import {
  emptyGlossary,
  type Character,
  type FileGlossary,
  type SeasonGlossary,
  type Term,
} from "./schemas.js";
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
): Promise<GlossaryPassResult> {
  const request = buildGlossaryRequest(context, seasonGlossary);
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
  if (file.register !== season.register) {
    problems.push(
      `the file glossary calls the register ${file.register} but the season glossary fixes ${season.register}`,
    );
  }
  return problems;
}

function mergeBy<T extends Character | Term>(
  fixed: readonly T[],
  extra: readonly T[],
  key: (entry: T) => string,
): T[] {
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
