import { isBlank } from "../text.js";
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

/** `01:52:07.21,01:52:09.94` — SubViewer 2.0 timings are in centiseconds. */
export const SUBVIEWER_TIMING =
  /^[ \t]*(\d{1,3}):([0-5]?\d):([0-5]?\d)\.(\d{1,3}),[ \t]*(\d{1,3}):([0-5]?\d):([0-5]?\d)\.(\d{1,3})[ \t]*$/;

/** SubViewer breaks lines with a literal `[br]` marker. */
export const SUBVIEWER_BREAK = "[br]";

/** True when the line is a SubViewer timing line. */
export function isSubViewerTimingLine(line: string): boolean {
  return SUBVIEWER_TIMING.test(line);
}

/** Parses the milliseconds out of a SubViewer timing line. */
export function parseSubViewerTiming(line: string): { startMs: number; endMs: number } | null {
  const match = SUBVIEWER_TIMING.exec(line);
  if (match === null) return null;
  const [, h1 = "0", m1 = "0", s1 = "0", f1 = "0", h2 = "0", m2 = "0", s2 = "0", f2 = "0"] = match;
  return {
    startMs: toMilliseconds(h1, m1, s1, f1, 2),
    endMs: toMilliseconds(h2, m2, s2, f2, 2),
  };
}

export function parseSubViewer(lines: readonly string[]): FormatParseResult {
  const firstTiming = lines.findIndex(isSubViewerTimingLine);
  const headerEnd = firstTiming === -1 ? lines.length : firstTiming;
  const headerLines = lines.slice(0, headerEnd);
  while (headerLines.length > 0 && isBlank(headerLines[headerLines.length - 1] ?? "")) {
    headerLines.pop();
  }

  const cues: Cue[] = [];
  const warnings: string[] = [];

  for (const block of readBlocks(lines.slice(headerEnd))) {
    const rawTimingLine = block.lines[0] ?? "";
    if (!isSubViewerTimingLine(rawTimingLine)) {
      warnings.push(
        `Ignored ${block.lines.length.toString()} line(s) at line ${(headerEnd + block.start + 1).toString()} that were not part of a cue.`,
      );
      continue;
    }
    const timing = parseSubViewerTiming(rawTimingLine);
    const textLines = block.lines.slice(1).flatMap((line) => line.split(SUBVIEWER_BREAK));
    const { linePrefixCodes, lines: cueLines } = protectLines(textLines);
    cues.push({
      id: cues.length + 1,
      rawIndexLine: null,
      rawTimingLine,
      startMs: timing?.startMs ?? 0,
      endMs: timing?.endMs ?? 0,
      prefixCodes: linePrefixCodes[0] ?? "",
      linePrefixCodes,
      lines: cueLines,
    });
  }

  return {
    header: headerLines.join("\n"),
    cues,
    trailingNewline: blockTrailingNewline(lines),
    warnings,
  };
}

export function serialiseSubViewer(doc: SubtitleDocument): string {
  const blocks = doc.cues.map((cue) => {
    const text = restoreLines(cue).join(SUBVIEWER_BREAK);
    return cue.lines.length === 0 ? cue.rawTimingLine : cue.rawTimingLine + doc.eol + text;
  });
  const body = joinBlocks(blocks, doc.eol, doc.trailingNewline);
  if (doc.header === "") return body;
  const header = doc.header.split("\n").join(doc.eol);
  return header + doc.eol + doc.eol + body;
}
