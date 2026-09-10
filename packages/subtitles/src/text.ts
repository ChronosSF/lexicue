import type { LineEnding } from "./types.js";

/** U+FEFF, the byte-order mark. */
export const BOM = String.fromCodePoint(0xfeff);

/**
 * The dominant line ending of a document. Mixed files (which real subtitle
 * archives contain) are normalised to whichever ending occurs more often.
 */
export function detectLineEnding(text: string): LineEnding {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > 0 && crlf >= lf ? "\r\n" : "\n";
}

/** Splits on any line ending; the returned strings never contain a terminator. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** Number of empty strings at the end of a split, i.e. trailing blank lines. */
export function countTrailingBlanks(lines: readonly string[]): number {
  let n = 0;
  for (let i = lines.length - 1; i >= 0 && lines[i] === ""; i -= 1) n += 1;
  return n;
}

/** True when a line has no content other than whitespace. */
export function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** Strips a leading byte-order mark and reports whether one was present. */
export function stripBom(text: string): { text: string; bom: boolean } {
  return text.startsWith(BOM) ? { text: text.slice(BOM.length), bom: true } : { text, bom: false };
}

/**
 * Encodes a serialised document as UTF-8, optionally with a byte-order mark.
 * Output is always UTF-8 whatever the input encoding was (spec section 3.1).
 * `TextEncoder` is available in browsers and in Node, so this stays browser-safe.
 */
export function encodeUtf8(text: string, options: { bom?: boolean } = {}): Uint8Array {
  const withBom = options.bom === true ? BOM + text : text;
  return new TextEncoder().encode(withBom);
}
