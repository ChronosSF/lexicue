import { assertTextSubtitleBytes } from "../detect.js";
import { SubtitleRejectedError } from "../errors.js";
import { parseSubtitleText } from "../parse.js";
import type { ParseOptions, SubtitleDocument } from "../types.js";

/**
 * The browser's half of spec section 3.1.
 *
 * `src/encoding` reads files with chardet and iconv-lite, which are Node
 * libraries and cannot run in the preview the upload screen shows. This module
 * does the same job with nothing but `TextDecoder`, which every browser ships
 * with the whole WHATWG label set: UTF-8, UTF-16 and every legacy code page the
 * specification names. Detecting which legacy code page a file is in is the one
 * piece `TextDecoder` does not provide, so it is scored here from the shape of
 * the decoded text instead of from chardet's n-gram tables.
 *
 * The two detectors are held together by `decode.test.ts`, which runs both over
 * the same bytes: what the browser previews has to be what the server charges.
 */

/**
 * The legacy code pages the detector may return, in the order it prefers them
 * when the score cannot separate two readings. Windows-1252 leads because two
 * Latin code pages that both turn the high bytes into plausible letters cannot
 * be told apart without a language model, and 1252 is much the commonest.
 */
export const BROWSER_LEGACY_ENCODINGS = [
  "windows-1252",
  "windows-1250",
  "windows-1251",
  "windows-1253",
  "windows-1254",
  "windows-1255",
  "windows-1256",
  "windows-1257",
  "windows-1258",
  "iso-8859-2",
  "iso-8859-5",
  "iso-8859-7",
  "koi8-r",
] as const;

export interface BrowserEncodingCandidate {
  encoding: string;
  /** The scorer's confidence, 0 to 100, on the same scale as the Node detector. */
  confidence: number;
}

export interface BrowserDetectedEncoding {
  /** Canonical lower-case label, for example "utf-8" or "windows-1251". */
  encoding: string;
  bom: boolean;
  confidence: number;
  /** Everything else the scorer considered, best first. */
  candidates: BrowserEncodingCandidate[];
}

export interface BrowserDecodedText {
  text: string;
  encoding: string;
  bom: boolean;
  confidence: number;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

/** Decides how to read a subtitle file, using only browser APIs. */
export function detectEncodingInBrowser(bytes: Uint8Array): BrowserDetectedEncoding {
  if (startsWith(bytes, UTF8_BOM)) {
    return { encoding: "utf-8", bom: true, confidence: 100, candidates: [] };
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    return { encoding: "utf-16le", bom: true, confidence: 100, candidates: [] };
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return { encoding: "utf-16be", bom: true, confidence: 100, candidates: [] };
  }
  if (isStrictUtf8(bytes)) {
    return { encoding: "utf-8", bom: false, confidence: 100, candidates: [] };
  }

  const candidates: BrowserEncodingCandidate[] = [];
  for (const encoding of BROWSER_LEGACY_ENCODINGS) {
    const text = tryDecode(bytes, encoding);
    if (text === null) continue;
    candidates.push({ encoding, confidence: scoreLegacyText(text) });
  }
  // The sort is stable, so candidates the scorer cannot tell apart keep the
  // declaration order above, which is the preference order.
  candidates.sort((a, b) => b.confidence - a.confidence);

  const best = candidates[0];
  return {
    // Windows-1252 is the safest fallback: a superset of ISO-8859-1 that never
    // fails to decode, so a file is read imperfectly rather than refused.
    encoding: best?.encoding ?? "windows-1252",
    bom: false,
    confidence: best?.confidence ?? 0,
    candidates,
  };
}

/** Decodes subtitle bytes to text. Everything this product writes back out is UTF-8. */
export function decodeSubtitleBytesInBrowser(
  bytes: Uint8Array,
  options: { encoding?: string } = {},
): BrowserDecodedText {
  const detected = detectEncodingInBrowser(bytes);
  const requested = options.encoding ?? detected.encoding;
  const requestedText = tryDecode(bytes, requested);
  const text = requestedText ?? tryDecode(bytes, "windows-1252") ?? "";
  return {
    text: stripLeadingBom(text),
    encoding: requestedText === null ? "windows-1252" : requested,
    bom: detected.bom,
    confidence: options.encoding === undefined ? detected.confidence : 100,
  };
}

/**
 * The whole read path in the browser: refuse image-based and binary files,
 * detect the encoding, decode, then parse. The counterpart of
 * `parseSubtitleBytes` in `src/encoding`, which is what the server runs.
 */
export function parseSubtitleBytesInBrowser(
  bytes: Uint8Array,
  options: ParseOptions = {},
): SubtitleDocument {
  assertTextSubtitleBytes(bytes, options.fileName);
  const decoded = decodeSubtitleBytesInBrowser(
    bytes,
    options.encoding === undefined ? {} : { encoding: options.encoding },
  );
  if (decoded.text === "") throw new SubtitleRejectedError("empty", options.fileName);
  return parseSubtitleText(decoded.text, {
    ...options,
    encoding: decoded.encoding,
    bom: options.bom ?? decoded.bom,
  });
}

/**
 * Scores one reading of the bytes, 0 to 100, from the shape of the text it
 * produced. Four things separate a right reading from a wrong one, and none of
 * them needs a language model:
 *
 * - **Junk.** A wrong code page turns dialogue into C1 controls, currency signs
 *   and box drawing. Those characters do not occur in subtitles at all.
 * - **Script coherence.** A file whose letters are nearly all high bytes is
 *   written in a non-Latin alphabet, so a reading that produces Latin letters
 *   from those bytes is wrong; a file that is mostly ASCII letters with the odd
 *   accent is a Latin-script language, so a reading that produces Cyrillic from
 *   its high bytes is wrong. This is what tells Windows-1251 from Windows-1250
 *   on the same Bulgarian file, where both readings are otherwise all letters.
 * - **One alphabet.** Real text does not mix three scripts.
 * - **Case.** Dialogue is mostly lower case, which is what separates
 *   Windows-1251 from KOI8-R: the two swap the case of the whole alphabet.
 */
function scoreLegacyText(text: string): number {
  let highBytes = 0;
  let asciiLetters = 0;
  let highLetters = 0;
  let latinHighLetters = 0;
  let lowercase = 0;
  let junk = 0;
  const byScript = new Map<string, number>();

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) {
      if (LETTER.test(character)) asciiLetters += 1;
      continue;
    }
    highBytes += 1;
    if (code === 0xfffd || code <= 0x9f) {
      junk += 1;
      continue;
    }
    if (LETTER.test(character)) {
      highLetters += 1;
      if (character !== character.toUpperCase()) lowercase += 1;
      const script = scriptOf(code);
      if (script === "latin") latinHighLetters += 1;
      byScript.set(script, (byScript.get(script) ?? 0) + 1);
      continue;
    }
    if (PLAUSIBLE_PUNCTUATION.has(character)) continue;
    junk += 1;
  }

  if (highBytes === 0) return 50;

  const dominant = Math.max(0, ...byScript.values());
  const letterShare = highLetters / highBytes;
  const scriptShare = highLetters === 0 ? 0 : dominant / highLetters;
  const lowercaseShare = highLetters === 0 ? 0 : lowercase / highLetters;
  const junkShare = junk / highBytes;
  const coherence = scriptCoherence(asciiLetters, highLetters, latinHighLetters);

  const score =
    letterShare * 30 +
    coherence * 35 +
    scriptShare * 15 +
    lowercaseShare * 10 +
    (1 - junkShare) * 10 -
    junkShare * 40;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * How well the high-byte letters agree with the ASCII ones. A file that is
 * half high-byte letters or more is not written in a Latin-script language, so
 * its high bytes should decode to a non-Latin alphabet; below that threshold
 * the opposite holds.
 */
function scriptCoherence(
  asciiLetters: number,
  highLetters: number,
  latinHighLetters: number,
): number {
  const letters = asciiLetters + highLetters;
  if (letters === 0 || highLetters === 0) return 0.5;
  const nonLatinHighLetters = highLetters - latinHighLetters;
  const expectNonLatin = highLetters / letters >= 0.5;
  return (expectNonLatin ? nonLatinHighLetters : latinHighLetters) / highLetters;
}

const LETTER = /\p{L}/u;

/** Characters that really do appear in subtitle dialogue, so they are not junk. */
const PLAUSIBLE_PUNCTUATION = new Set([
  " ",
  "¡",
  "«",
  "»",
  "¿",
  "·",
  "·",
  ";",
  "–",
  "—",
  "‘",
  "’",
  "‚",
  "“",
  "”",
  "„",
  "…",
  "‹",
  "›",
  "♪",
  "♫",
]);

/** Coarse script buckets; only the majority matters, not the exact block. */
function scriptOf(code: number): string {
  if (code >= 0x0400 && code <= 0x04ff) return "cyrillic";
  if (code >= 0x0370 && code <= 0x03ff) return "greek";
  if (code >= 0x0590 && code <= 0x05ff) return "hebrew";
  if (code >= 0x0600 && code <= 0x06ff) return "arabic";
  return "latin";
}

function tryDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
