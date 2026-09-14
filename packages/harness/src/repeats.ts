import { stripMarkup } from "@lexicue/subtitles";
import type { ProtocolCue } from "./types.js";

/**
 * A cue text that occurs more than once in the source, word for word.
 *
 * Recurring lines are the seam a batched translation shows at: the 400-cue
 * fixture's "The line doesn't care." falls in every one of its four batches,
 * and nothing but a decision taken once, before any batch runs, can keep the
 * four renderings the same. The judged run of 14 September 2026 rendered that
 * line consistently inside one run but differently between two runs, which is
 * the same fault seen from a day apart.
 *
 * Detection is deterministic and needs no model: the glossary pass is told
 * which lines repeat, fixes one rendering for each, and every batch is given
 * those renderings with the rest of the glossary.
 */
export interface RepeatedLine {
  /** The cue text as the source writes it, taken from the first occurrence. */
  text: string;
  /** How many cues carry it. */
  occurrences: number;
  /**
   * The cue ids that carry it, ascending. Filled for a single file; empty for
   * an upload-wide group, where ids from different files would collide.
   */
  ids: number[];
}

export interface RepeatOptions {
  /** Shortest normalised text worth fixing a rendering for. */
  minChars?: number;
  /** Fewest words worth fixing a rendering for. */
  minWords?: number;
  /** Most groups to carry into a request, so the glossary stays bounded. */
  limit?: number;
}

/**
 * The floors exist to keep the list meaningful. "Yes." and "No." repeat in
 * every film ever written and need no fixed rendering; a line long enough to
 * have a shape is a line a viewer recognises when it comes back.
 */
export const REPEAT_MIN_CHARS = 12;
export const REPEAT_MIN_WORDS = 3;
export const REPEAT_LIMIT = 20;

/**
 * What counts as the same line. Markup and control codes come off, the
 * typographic variants of quotes, dashes and ellipses are folded onto one
 * spelling, whitespace is collapsed, surrounding punctuation is dropped and the
 * rest is lower-cased.
 *
 * The point of folding punctuation is that a line is the same line whether it
 * ends in a full stop or a dash, and whether the file was written with curly
 * quotes or straight ones. The point of stopping there is that two lines
 * differing by a word are two lines: "Write that in the log." and "Write it in
 * the log." are different sentences and must be free to translate differently.
 */
export function repeatKey(text: string): string {
  return stripMarkup(text)
    .replaceAll(/[‘’‛]/gu, "'")
    .replaceAll(/[“”‟]/gu, '"')
    .replaceAll("…", "...")
    .replaceAll(/[‐-―]/gu, "-")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/^[\s"'([-]+|[\s"')\],.!?:;-]+$/gu, "")
    .toLowerCase();
}

/** The repeated cue texts of one file, most frequent first. */
export function findRepeatedLines(
  cues: readonly ProtocolCue[],
  options: RepeatOptions = {},
): RepeatedLine[] {
  const groups = new Map<string, { text: string; ids: number[] }>();
  for (const cue of cues) {
    const text = cue.lines.join(" ");
    const key = repeatKey(text);
    if (!worthFixing(key, options)) continue;
    const found = groups.get(key);
    if (found === undefined) groups.set(key, { text, ids: [cue.id] });
    else found.ids.push(cue.id);
  }
  return rank(
    [...groups.values()]
      .filter((group) => group.ids.length > 1)
      .map((group) => ({
        text: group.text,
        occurrences: group.ids.length,
        ids: [...group.ids].sort((left, right) => left - right),
      })),
    options,
  );
}

/**
 * The repeated cue texts of a whole upload: a catchphrase that a season says
 * once an episode repeats across the set without repeating inside any one file,
 * and the season glossary is the only pass that can fix it for all of them.
 */
export function findRepeatedLinesAcross(
  files: readonly (readonly ProtocolCue[])[],
  options: RepeatOptions = {},
): RepeatedLine[] {
  const groups = new Map<string, { text: string; occurrences: number }>();
  for (const cues of files) {
    for (const cue of cues) {
      const text = cue.lines.join(" ");
      const key = repeatKey(text);
      if (!worthFixing(key, options)) continue;
      const found = groups.get(key);
      if (found === undefined) groups.set(key, { text, occurrences: 1 });
      else found.occurrences += 1;
    }
  }
  return rank(
    [...groups.values()]
      .filter((group) => group.occurrences > 1)
      .map((group) => ({ text: group.text, occurrences: group.occurrences, ids: [] })),
    options,
  );
}

function worthFixing(key: string, options: RepeatOptions): boolean {
  if (key === "") return false;
  if (key.length < (options.minChars ?? REPEAT_MIN_CHARS)) return false;
  return key.split(" ").length >= (options.minWords ?? REPEAT_MIN_WORDS);
}

/**
 * Most frequent first, ties broken by the text, so the same file always
 * produces the same list in the same order: the glossary request is part of a
 * job's prompt, and a list that reordered between two runs would be a
 * difference nobody asked for.
 */
function rank(lines: RepeatedLine[], options: RepeatOptions): RepeatedLine[] {
  return lines
    .sort(
      (left, right) => right.occurrences - left.occurrences || (left.text < right.text ? -1 : 1),
    )
    .slice(0, options.limit ?? REPEAT_LIMIT);
}
