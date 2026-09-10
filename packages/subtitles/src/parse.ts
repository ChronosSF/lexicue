import { documentDialogueChars } from "./chars.js";
import { detectFormat } from "./detect.js";
import { SubtitleRejectedError } from "./errors.js";
import { parseMicroDvd } from "./formats/microdvd.js";
import { parseSrt } from "./formats/srt.js";
import { parseSubViewer } from "./formats/subviewer.js";
import { MAX_CUES_PER_FILE } from "./limits.js";
import { detectLineEnding, splitLines, stripBom } from "./text.js";
import type { ParseOptions, SubtitleDocument, SubtitleFormat } from "./types.js";

/**
 * Parses subtitle text into the document model of spec section 4.3.
 *
 * The input is text, not bytes: decoding lives in the `./encoding` entry point
 * so this module has no dependencies and runs unchanged in the browser.
 */
export function parseSubtitleText(input: string, options: ParseOptions = {}): SubtitleDocument {
  const stripped = stripBom(input);
  const text = stripped.text;
  const bom = options.bom ?? stripped.bom;

  if (text.trim() === "") throw new SubtitleRejectedError("empty", options.fileName);

  const format = options.format ?? detectFormat(text, options.fileName);
  if (format === null) throw new SubtitleRejectedError("unknown-format", options.fileName);

  const eol = detectLineEnding(text);
  const lines = splitLines(text);
  const parsed = parseWithFormat(format, lines, options);

  if (parsed.cues.length === 0) throw new SubtitleRejectedError("no-cues", options.fileName);
  if (parsed.cues.length > MAX_CUES_PER_FILE) {
    throw new SubtitleRejectedError("too-many-cues", options.fileName);
  }

  const doc: SubtitleDocument = {
    format,
    encoding: options.encoding ?? "utf-8",
    bom,
    eol,
    header: parsed.header,
    cues: parsed.cues,
    trailingNewline: parsed.trailingNewline,
    dialogueChars: documentDialogueChars(parsed.cues),
    warnings: parsed.warnings,
  };
  if (parsed.frameRate !== undefined) doc.frameRate = parsed.frameRate;
  return doc;
}

function parseWithFormat(
  format: SubtitleFormat,
  lines: readonly string[],
  options: ParseOptions,
): ReturnType<typeof parseSrt> {
  switch (format) {
    case "srt":
      return parseSrt(lines);
    case "microdvd":
      return parseMicroDvd(
        lines,
        options.defaultFrameRate === undefined
          ? {}
          : { defaultFrameRate: options.defaultFrameRate },
      );
    case "subviewer":
      return parseSubViewer(lines);
  }
}
