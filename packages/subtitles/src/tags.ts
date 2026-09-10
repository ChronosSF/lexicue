/**
 * Inline formatting tags the harness must preserve as a multiset: `<i>`, `<b>`,
 * `<u>`, `<font ...>` and their closing forms (spec section 4.1).
 */
const INLINE_TAG_SOURCE = String.raw`<\/?\s*(?:i|b|u|font)(?:\s[^<>]*)?\s*\/?>`;

/**
 * Control codes that the model must never be free to rewrite: SubStation-style
 * positioning overrides such as `{\an8}` and MicroDVD codes such as `{y:i}` or
 * `{c:$0000ff}`.
 *
 * Codes at the very start of a line are stripped out of the cue entirely and
 * re-attached on the way back (see `splitLeadingCodes`). Codes further along a
 * line — MicroDVD writes `- Yes.|- {y:i}Never.`, with the code after the speaker
 * dash — stay in the text the model sees and are protected the same way inline
 * tags are: by the markup multiset check and a retry.
 */
const CONTROL_CODE_SOURCE = String.raw`\{(?:\\[^{}\r\n]*|[A-Za-z]:[^{}\r\n]*)\}`;

const INLINE_TAG = new RegExp(INLINE_TAG_SOURCE, "gi");
const CONTROL_CODE = new RegExp(CONTROL_CODE_SOURCE, "g");
const MARKUP = new RegExp(`${INLINE_TAG_SOURCE}|${CONTROL_CODE_SOURCE}`, "gi");
const LEADING_CONTROL_CODES = new RegExp(`^(?:${CONTROL_CODE_SOURCE})+`);

/** Splits the control codes at the start of a line from the rest of the line. */
export function splitLeadingCodes(line: string): { codes: string; rest: string } {
  const match = LEADING_CONTROL_CODES.exec(line);
  if (match === null) return { codes: "", rest: line };
  return { codes: match[0], rest: line.slice(match[0].length) };
}

/** Removes every inline tag and control code, leaving the spoken characters. */
export function stripMarkup(text: string): string {
  return text.replace(MARKUP, "");
}

/**
 * Normalises a tag for multiset comparison: the tag name is lower-cased and
 * inner whitespace collapsed, while attributes such as `color="#ffffff"` are
 * kept, so a translation that drops a font colour still fails the check.
 */
export function normaliseTag(tag: string): string {
  return tag
    .replace(/\s+/g, " ")
    .replace(/^<\s*/, "<")
    .replace(/^<\/\s*/, "</")
    .replace(/\s*>$/, ">")
    .replace(/^(<\/?)([A-Za-z]+)/, (_all, open: string, name: string) => open + name.toLowerCase());
}

/** Every inline tag in the text, in order, normalised. */
export function listTags(text: string): string[] {
  return (text.match(INLINE_TAG) ?? []).map(normaliseTag);
}

/** Every control code in the text, in order. */
export function listControlCodes(text: string): string[] {
  return text.match(CONTROL_CODE) ?? [];
}

/** Every inline tag and control code in the text, in order, normalised. */
export function listMarkup(text: string): string[] {
  return (text.match(MARKUP) ?? []).map((token) =>
    token.startsWith("<") ? normaliseTag(token) : token,
  );
}

/** One piece of a line: either a markup token or a run of plain text. */
export interface MarkupSegment {
  markup: boolean;
  value: string;
}

/**
 * Splits a line into markup tokens and the plain text between them. The harness
 * uses this to transform only the words — re-wrapping a cue in the source's
 * outer tags, or, in the fake model client, wrapping the dialogue in guillemets
 * without touching a single tag.
 */
export function splitMarkup(text: string): MarkupSegment[] {
  const segments: MarkupSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(new RegExp(MARKUP.source, "gi"))) {
    const index = match.index;
    if (index > cursor) segments.push({ markup: false, value: text.slice(cursor, index) });
    segments.push({ markup: true, value: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) segments.push({ markup: false, value: text.slice(cursor) });
  return segments;
}

/** The multiset of inline tags in the text, keyed by normalised tag. */
export function tagMultiset(text: string): Map<string, number> {
  return countTokens(listTags(text));
}

/** The multiset of inline tags and control codes, keyed by normalised token. */
export function markupMultiset(text: string): Map<string, number> {
  return countTokens(listMarkup(text));
}

/** True when two texts carry exactly the same inline tags, placement aside. */
export function tagMultisetsEqual(a: string, b: string): boolean {
  return multisetsEqual(tagMultiset(a), tagMultiset(b));
}

/** True when two texts carry the same tags and control codes, placement aside. */
export function markupMultisetsEqual(a: string, b: string): boolean {
  return multisetsEqual(markupMultiset(a), markupMultiset(b));
}

/** A readable rendering of the markup in a text, used in validator findings. */
export function describeMarkup(text: string): string {
  const tokens = listMarkup(text);
  return tokens.length === 0 ? "no tags" : tokens.join(" ");
}

function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function multisetsEqual(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [token, count] of left) {
    if (right.get(token) !== count) return false;
  }
  return true;
}
