import { DEFAULT_FRAME_RATE } from "../limits.js";
import { countTrailingBlanks, isBlank } from "../text.js";
import type { Cue, SubtitleDocument } from "../types.js";
import { protectLines, restoreLines, type FormatParseResult } from "./common.js";

/** `{2688}{2753}- Don't tell me you forgot.|- {y:i}Never.` */
export const MICRODVD_LINE = /^\{(-?\d+)\}\{(-?\d+)\}(.*)$/;

/** `{1}{1}23.976` — the optional first line that carries the frame rate. */
const FRAME_RATE_TEXT = /^\d{1,3}(?:[.,]\d+)?$/;

/** True when the line has MicroDVD's `{start}{end}` shape. */
export function isMicroDvdLine(line: string): boolean {
  return MICRODVD_LINE.test(line);
}

/** True when the line is MicroDVD's optional frame-rate header line. */
export function isMicroDvdFrameRateLine(line: string): boolean {
  const match = MICRODVD_LINE.exec(line);
  return match !== null && FRAME_RATE_TEXT.test(match[3] ?? "");
}

export function parseMicroDvd(
  lines: readonly string[],
  options: { defaultFrameRate?: number } = {},
): FormatParseResult {
  const cues: Cue[] = [];
  const warnings: string[] = [];
  let header = "";
  let frameRate = options.defaultFrameRate ?? DEFAULT_FRAME_RATE;
  let sawFrameRateLine = false;

  const body = lines.slice(0, lines.length - countTrailingBlanks(lines));

  for (const [index, line] of body.entries()) {
    if (isBlank(line)) {
      warnings.push(`Ignored a blank line at line ${(index + 1).toString()}.`);
      continue;
    }
    const match = MICRODVD_LINE.exec(line);
    if (match === null) {
      warnings.push(`Ignored line ${(index + 1).toString()}, which is not a MicroDVD cue.`);
      continue;
    }
    const [, startFrame = "0", endFrame = "0", text = ""] = match;
    if (!sawFrameRateLine && cues.length === 0 && FRAME_RATE_TEXT.test(text)) {
      header = line;
      frameRate = Number(text.replace(",", ".")) || frameRate;
      sawFrameRateLine = true;
      continue;
    }
    const rawTimingLine = line.slice(0, line.length - text.length);
    const { linePrefixCodes, lines: cueLines } = protectLines(text.split("|"));
    cues.push({
      id: cues.length + 1,
      rawIndexLine: null,
      rawTimingLine,
      startMs: framesToMs(Number(startFrame), frameRate),
      endMs: framesToMs(Number(endFrame), frameRate),
      prefixCodes: linePrefixCodes[0] ?? "",
      linePrefixCodes,
      lines: cueLines,
    });
  }

  return {
    header,
    cues,
    trailingNewline: countTrailingBlanks(lines) >= 1,
    frameRate,
    warnings,
  };
}

export function serialiseMicroDvd(doc: SubtitleDocument): string {
  const out: string[] = [];
  if (doc.header !== "") out.push(doc.header);
  for (const cue of doc.cues) out.push(cue.rawTimingLine + restoreLines(cue).join("|"));
  return out.join(doc.eol) + (doc.trailingNewline ? doc.eol : "");
}

function framesToMs(frame: number, frameRate: number): number {
  if (!Number.isFinite(frameRate) || frameRate <= 0) return 0;
  return Math.round((frame / frameRate) * 1000);
}
