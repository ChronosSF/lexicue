import type { Cue, SubtitleDocument } from "../types.js";
import {
  blockTrailingNewline,
  joinBlocks,
  protectLines,
  readBlocks,
  restoreLines,
  toMilliseconds,
  type FormatParseResult,
} from "./common.js";

/**
 * A SubRip timing line. Real files use a comma or a period before the
 * milliseconds, one to three millisecond digits, `-->` or `->`, and may carry
 * position hints (`X1:100 X2:620 Y1:420 Y2:480`) after the arrow. Everything
 * after the arrow is kept verbatim as part of the raw timing line.
 */
export const SRT_TIMING =
  /^[ \t]*(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})[ \t]*-{1,3}>[ \t]*(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})[ \t]*(.*)$/;

/** True when the line is a SubRip timing line. */
export function isSrtTimingLine(line: string): boolean {
  return SRT_TIMING.test(line);
}

/** Parses the milliseconds out of a SubRip timing line. */
export function parseSrtTiming(line: string): { startMs: number; endMs: number } | null {
  const match = SRT_TIMING.exec(line);
  if (match === null) return null;
  const [, h1 = "0", m1 = "0", s1 = "0", f1 = "0", h2 = "0", m2 = "0", s2 = "0", f2 = "0"] = match;
  return {
    startMs: toMilliseconds(h1, m1, s1, f1, 3),
    endMs: toMilliseconds(h2, m2, s2, f2, 3),
  };
}

export function parseSrt(lines: readonly string[]): FormatParseResult {
  const cues: Cue[] = [];
  const warnings: string[] = [];

  for (const block of readBlocks(lines)) {
    const found = findTimingLine(block.lines);
    if (found === null) {
      warnings.push(
        `Ignored ${block.lines.length.toString()} line(s) at line ${(block.start + 1).toString()} that were not part of a cue.`,
      );
      continue;
    }
    if (found.index > 1) {
      const ignored = found.index - 1;
      warnings.push(
        `Ignored ${ignored.toString()} stray line(s) before the timing line at line ${(block.start + found.index + 1).toString()}.`,
      );
    }
    const { linePrefixCodes, lines: text } = protectLines(block.lines.slice(found.index + 1));
    cues.push({
      id: cues.length + 1,
      rawIndexLine: found.indexLine,
      rawTimingLine: found.line,
      startMs: found.timing.startMs,
      endMs: found.timing.endMs,
      prefixCodes: linePrefixCodes[0] ?? "",
      linePrefixCodes,
      lines: text,
    });
  }

  return {
    header: "",
    cues,
    trailingNewline: blockTrailingNewline(lines),
    warnings,
  };
}

interface FoundTiming {
  index: number;
  line: string;
  indexLine: string | null;
  timing: { startMs: number; endMs: number };
}

/** The first timing line in a block, with the line above it, which is the index. */
function findTimingLine(blockLines: readonly string[]): FoundTiming | null {
  let previous: string | null = null;
  for (const [index, line] of blockLines.entries()) {
    const timing = parseSrtTiming(line);
    if (timing !== null) return { index, line, indexLine: previous, timing };
    previous = line;
  }
  return null;
}

export function serialiseSrt(doc: SubtitleDocument): string {
  const blocks = doc.cues.map((cue) => {
    const parts: string[] = [];
    if (cue.rawIndexLine !== null) parts.push(cue.rawIndexLine);
    parts.push(cue.rawTimingLine, ...restoreLines(cue));
    return parts.join(doc.eol);
  });
  return joinBlocks(blocks, doc.eol, doc.trailingNewline);
}
