import { splitMarkup, stripMarkup } from "@lexicue/subtitles";

/**
 * Re-flows a cue's lines to at most `maxLines`, breaking at the nearest
 * punctuation (spec section 4.6). Markup is carried along with the words it
 * wraps, so a re-flow never changes the multiset of tags in the cue.
 */
export function reflowLines(lines: readonly string[], maxLines: number): string[] {
  if (maxLines < 1) throw new RangeError("maxLines must be at least 1");
  const nonEmpty = lines.map((line) => line.trim()).filter((line) => line !== "");
  if (nonEmpty.length === 0) return [...lines];
  if (nonEmpty.length <= maxLines) return nonEmpty;

  const joined = nonEmpty.join(" ");
  if (maxLines === 1) return [joined];

  const tokens = tokenise(joined);
  const totalWidth = tokens.reduce((sum, token) => sum + token.width, 0);
  const target = Math.ceil(totalWidth / maxLines);

  const out: string[] = [];
  let current: Token[] = [];
  let width = 0;
  for (const [index, token] of tokens.entries()) {
    current.push(token);
    width += token.width;
    const remaining = tokens.length - index - 1;
    const linesLeft = maxLines - out.length - 1;
    const mustBreak = width >= target && linesLeft > 0 && remaining >= linesLeft;
    if (mustBreak && (token.breakAfter || remaining === linesLeft)) {
      out.push(render(current));
      current = [];
      width = 0;
    }
  }
  if (current.length > 0) out.push(render(current));
  return out.length <= maxLines
    ? out
    : [...out.slice(0, maxLines - 1), out.slice(maxLines - 1).join(" ")];
}

/**
 * Forces a translation to the number of lines the source cue had, for the
 * "keep the original line count" setting of spec section 3.4.
 */
export function matchLineCount(lines: readonly string[], count: number): string[] {
  if (count < 1) return [...lines];
  const reflowed = reflowLines(lines, count);
  if (reflowed.length === count) return reflowed;
  if (reflowed.length > count) {
    return [...reflowed.slice(0, count - 1), reflowed.slice(count - 1).join(" ")];
  }
  return [...reflowed, ...Array.from({ length: count - reflowed.length }, () => "")];
}

interface Token {
  text: string;
  width: number;
  /** True when this word ends with punctuation a subtitle may break after. */
  breakAfter: boolean;
}

const BREAK_AFTER = /[.!?…:;,—–-]["'»”)\]]?$/u;

function tokenise(text: string): Token[] {
  return text
    .split(/\s+/u)
    .filter((word) => word !== "")
    .map((word) => {
      const plain = stripMarkup(word);
      return {
        text: word,
        width: plain.length + 1,
        breakAfter: BREAK_AFTER.test(plain),
      };
    });
}

function render(tokens: readonly Token[]): string {
  return tokens.map((token) => token.text).join(" ");
}

/**
 * Re-wraps a translated cue in the source cue's outer tags. Used when the tag
 * multiset does not match but the source's tags sit only at the edges of its
 * lines, which is the "only the placement is wrong" case of spec section 4.6.
 *
 * Returns null when the source has tags in the middle of a line, where no
 * mechanical re-wrap can be trusted and the cue is retried instead.
 */
export function rewrapWithSourceTags(
  sourceLines: readonly string[],
  translatedLines: readonly string[],
): string[] | null {
  if (sourceLines.length !== translatedLines.length) return null;
  const out: string[] = [];
  for (const [index, sourceLine] of sourceLines.entries()) {
    const wrapped = rewrapLine(sourceLine, translatedLines[index] ?? "");
    if (wrapped === null) return null;
    out.push(wrapped);
  }
  return out;
}

/**
 * Whitespace and a speaker dash, which sit outside the cue's formatting: a
 * two-speaker cue is written `- No.` / `- <i>Never.</i>`, so the wrapper has to
 * be looked for after the dash rather than at the start of the line.
 */
const DIALOGUE_PREFIX = /^\s*(?:[-–—]\s*)?/u;

function rewrapLine(sourceLine: string, translatedLine: string): string | null {
  const sourcePrefix = DIALOGUE_PREFIX.exec(sourceLine)?.[0] ?? "";
  const translatedPrefix = DIALOGUE_PREFIX.exec(translatedLine)?.[0] ?? "";
  const segments = splitMarkup(sourceLine.slice(sourcePrefix.length));
  let start = 0;
  let lead = "";
  while (start < segments.length && segments[start]?.markup === true) {
    lead += segments[start]?.value ?? "";
    start += 1;
  }
  let end = segments.length - 1;
  let trail = "";
  while (end >= start && segments[end]?.markup === true) {
    trail = (segments[end]?.value ?? "") + trail;
    end -= 1;
  }
  for (let index = start; index <= end; index += 1) {
    if (segments[index]?.markup === true) return null;
  }
  const stripped = splitMarkup(translatedLine.slice(translatedPrefix.length))
    .filter((segment) => !segment.markup)
    .map((segment) => segment.value)
    .join("");
  return translatedPrefix + lead + stripped + trail;
}
