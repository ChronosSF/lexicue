import { FidelityError } from "./errors.js";
import { restoreLines } from "./formats/common.js";
import { parseSubtitleText } from "./parse.js";
import { serialiseSubtitleDocument } from "./serialise.js";
import type { SubtitleDocument } from "./types.js";

/**
 * The guarantee of spec section 4.1: the output has the same number of cues in
 * the same order, and every index line and timing line is the same bytes as the
 * input. Any difference is a bug, so it throws rather than degrading the file.
 */
export function assertStructuralFidelity(source: SubtitleDocument, output: SubtitleDocument): void {
  if (source.format !== output.format) {
    throw new FidelityError(`format changed from ${source.format} to ${output.format}`);
  }
  if (source.cues.length !== output.cues.length) {
    throw new FidelityError(
      `cue count changed from ${source.cues.length.toString()} to ${output.cues.length.toString()}`,
    );
  }
  if (source.header !== output.header) {
    throw new FidelityError("the header block changed");
  }
  for (const [index, sourceCue] of source.cues.entries()) {
    const outputCue = output.cues[index];
    if (outputCue === undefined)
      throw new FidelityError(`cue ${sourceCue.id.toString()} is missing`);
    if (sourceCue.rawIndexLine !== outputCue.rawIndexLine) {
      throw new FidelityError(
        `the index line of cue ${sourceCue.id.toString()} changed from ${JSON.stringify(sourceCue.rawIndexLine)} to ${JSON.stringify(outputCue.rawIndexLine)}`,
      );
    }
    if (sourceCue.rawTimingLine !== outputCue.rawTimingLine) {
      throw new FidelityError(
        `the timing line of cue ${sourceCue.id.toString()} changed from ${JSON.stringify(sourceCue.rawTimingLine)} to ${JSON.stringify(outputCue.rawTimingLine)}`,
      );
    }
    if (sourceCue.linePrefixCodes.join("") !== outputCue.linePrefixCodes.join("")) {
      throw new FidelityError(
        `the control codes of cue ${sourceCue.id.toString()} changed from ${JSON.stringify(sourceCue.linePrefixCodes)} to ${JSON.stringify(outputCue.linePrefixCodes)}`,
      );
    }
  }
}

/**
 * Serialises a translated document and re-parses the result, proving the file
 * that will be stored still matches the source structurally.
 */
export function serialiseAndVerify(
  source: SubtitleDocument,
  translated: SubtitleDocument,
): { text: string; reparsed: SubtitleDocument } {
  const text = serialiseSubtitleDocument(translated);
  const reparsed = parseSubtitleText(text, {
    format: translated.format,
    encoding: translated.encoding,
    bom: translated.bom,
    ...(translated.frameRate === undefined ? {} : { defaultFrameRate: translated.frameRate }),
  });
  assertStructuralFidelity(source, reparsed);
  assertLinesSurvivedSerialisation(translated, reparsed);
  return { text, reparsed };
}

/**
 * The structural comparison above proves the cues, indices and timings came
 * back. This proves the text did too: a translation that contains a blank line,
 * a MicroDVD pipe or a SubViewer `[br]` would be silently re-cut by the format
 * on the way back in, dropping or splitting lines that the cue-level comparison
 * cannot see.
 */
function assertLinesSurvivedSerialisation(
  translated: SubtitleDocument,
  reparsed: SubtitleDocument,
): void {
  for (const [index, cue] of translated.cues.entries()) {
    const back = reparsed.cues[index];
    const before = restoreLines(cue);
    const after = back === undefined ? [] : restoreLines(back);
    if (before.length !== after.length || before.some((line, i) => line !== after[i])) {
      throw new FidelityError(
        `the text of cue ${cue.id.toString()} did not survive serialisation: wrote ${JSON.stringify(before)} but read back ${JSON.stringify(after)}`,
      );
    }
  }
  if (reparsed.warnings.length > 0) {
    throw new FidelityError(
      `re-parsing the output produced warnings: ${reparsed.warnings.join(" ")}`,
    );
  }
}
