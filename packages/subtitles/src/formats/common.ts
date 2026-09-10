import { countTrailingBlanks, isBlank } from "../text.js";
import { splitLeadingCodes } from "../tags.js";
import type { Cue } from "../types.js";

/** What one format's parser hands back before the document is assembled. */
export interface FormatParseResult {
  header: string;
  cues: Cue[];
  trailingNewline: boolean;
  frameRate?: number;
  warnings: string[];
}

/** A run of consecutive non-blank lines, with the index it started at. */
export interface Block {
  start: number;
  lines: string[];
}

/** Splits lines into blank-line separated blocks, ignoring extra blank lines. */
export function readBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const [index, line] of lines.entries()) {
    if (isBlank(line)) {
      current = null;
      continue;
    }
    if (current === null) {
      current = { start: index, lines: [] };
      blocks.push(current);
    }
    current.lines.push(line);
  }
  return blocks;
}

/**
 * For blank-line separated formats a document ends either with the customary
 * blank line after the last cue (two trailing newlines) or with a single
 * newline. `trailingNewline` records which, so both round-trip byte for byte.
 */
export function blockTrailingNewline(lines: readonly string[]): boolean {
  return countTrailingBlanks(lines) >= 2;
}

/** Joins cue blocks the way blank-line separated formats are written out. */
export function joinBlocks(
  blocks: readonly string[],
  eol: string,
  trailingNewline: boolean,
): string {
  return blocks.map((block) => block + eol).join(eol) + (trailingNewline ? eol : "");
}

/** Splits every text line into its leading control codes and the text itself. */
export function protectLines(rawLines: readonly string[]): {
  linePrefixCodes: string[];
  lines: string[];
} {
  const linePrefixCodes: string[] = [];
  const lines: string[] = [];
  for (const raw of rawLines) {
    const { codes, rest } = splitLeadingCodes(raw);
    linePrefixCodes.push(codes);
    lines.push(rest);
  }
  return { linePrefixCodes, lines };
}

/** Re-attaches the protected codes to translated lines. */
export function restoreLines(cue: Pick<Cue, "linePrefixCodes" | "lines">): string[] {
  return cue.lines.map((line, index) => (cue.linePrefixCodes[index] ?? "") + line);
}

/** Milliseconds from a split timestamp; fractions are padded to milliseconds. */
export function toMilliseconds(
  hours: string,
  minutes: string,
  seconds: string,
  fraction: string,
  fractionDigits: number,
): number {
  const padded = fraction.padEnd(fractionDigits, "0").slice(0, fractionDigits);
  const scale = 10 ** (3 - fractionDigits);
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    Number(padded) * scale
  );
}
