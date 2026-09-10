import { stripMarkup } from "./tags.js";
import type { Cue } from "./types.js";

/**
 * The billable character count of one cue (spec sections 4.3 and 6.1): the
 * characters of `lines` once inline tags and control codes are removed and line
 * breaks are dropped. Spaces and punctuation count; timecodes, indices, tags and
 * control codes do not.
 *
 * Line breaks are dropped rather than replaced by a space, which is what makes
 * the same dialogue cost the same in SubRip (`\n`), MicroDVD (`|`) and
 * SubViewer (`[br]`) form.
 *
 * Counting is by Unicode code point, so an emoji or an astral CJK character
 * counts once rather than twice.
 */
export function cueDialogueChars(cue: Pick<Cue, "lines">): number {
  let total = 0;
  for (const line of cue.lines) {
    total += countCodePoints(stripMarkup(line));
  }
  return total;
}

/** The billable character count of a whole document. */
export function documentDialogueChars(cues: readonly Pick<Cue, "lines">[]): number {
  let total = 0;
  for (const cue of cues) total += cueDialogueChars(cue);
  return total;
}

/** The spoken text of a cue with markup removed, used by the advisory metrics. */
export function cuePlainText(cue: Pick<Cue, "lines">): string {
  return cue.lines.map((line) => stripMarkup(line)).join(" ");
}

function countCodePoints(text: string): number {
  return Array.from(text).length;
}
