import type { Cue, SubtitleDocument } from "@subtitle-translator/subtitles";
import { documentDialogueChars } from "@subtitle-translator/subtitles";

/**
 * Builds the output document from the source document and the translated lines
 * (spec section 4.4). Nothing but `lines` changes: the raw index line and the
 * raw timing line are the same objects' strings, so the fidelity guarantee
 * holds by construction and is then proved by re-parsing the result.
 */
export function reassembleDocument(
  source: SubtitleDocument,
  translations: ReadonlyMap<number, readonly string[]>,
): SubtitleDocument {
  const cues: Cue[] = source.cues.map((cue) => {
    const translated = translations.get(cue.id);
    if (translated === undefined) return cue;
    const lines = [...translated];
    return {
      ...cue,
      lines,
      linePrefixCodes: alignCodes(cue.linePrefixCodes, lines.length),
    };
  });
  return { ...source, cues, dialogueChars: documentDialogueChars(cues) };
}

/**
 * Keeps one protected-code slot per line when a translation has a different
 * number of lines from its source. The cue's own leading codes stay on the
 * first line, where they belong; extra lines get none.
 */
function alignCodes(codes: readonly string[], lineCount: number): string[] {
  if (codes.length === lineCount) return [...codes];
  const aligned = Array.from({ length: lineCount }, (_unused, index) => codes[index] ?? "");
  if (lineCount > 0 && codes.length > lineCount) {
    // Codes that would otherwise be dropped are moved onto the last line so no
    // control code is ever lost from a cue.
    const overflow = codes.slice(lineCount).join("");
    aligned[lineCount - 1] = (aligned[lineCount - 1] ?? "") + overflow;
  }
  return aligned;
}
