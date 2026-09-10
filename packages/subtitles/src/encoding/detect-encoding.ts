import chardet from "chardet";
import iconv from "iconv-lite";

/**
 * The legacy single-byte code pages spec section 3.1 names explicitly. They are
 * what Central and Eastern European subtitle archives are full of.
 */
export const SPEC_LEGACY_ENCODINGS = [
  "windows-1250",
  "windows-1251",
  "windows-1252",
  "windows-1253",
  "windows-1254",
  "iso-8859-1",
  "iso-8859-2",
  "iso-8859-3",
  "iso-8859-4",
  "iso-8859-5",
  "iso-8859-6",
  "iso-8859-7",
  "iso-8859-8",
  "iso-8859-9",
  "iso-8859-13",
  "iso-8859-15",
] as const;

/**
 * Everything the detector is allowed to return. The four code pages beyond the
 * spec's list (Hebrew, Arabic, Baltic, Vietnamese and KOI8-R) are accepted
 * because the detector can produce them and refusing a file we can read
 * perfectly well would be worse for the user than reading it.
 */
export const CANDIDATE_LEGACY_ENCODINGS = [
  ...SPEC_LEGACY_ENCODINGS,
  "windows-1255",
  "windows-1256",
  "windows-1257",
  "windows-1258",
  "windows-874",
  "koi8-r",
] as const;

const LEGACY = new Set<string>(CANDIDATE_LEGACY_ENCODINGS);
const SPEC_PREFERRED = new Set<string>(SPEC_LEGACY_ENCODINGS);

/** One possible reading of the bytes, with the detector's confidence, 0 to 100. */
export interface EncodingCandidate {
  encoding: string;
  confidence: number;
}

/** What the detector concluded about a file's bytes. */
export interface DetectedEncoding {
  /** Canonical lower-case label, for example "utf-8" or "windows-1251". */
  encoding: string;
  /** Whether the bytes started with a byte-order mark. */
  bom: boolean;
  /** 100 for a byte-order mark or a clean strict UTF-8 decode, else the detector's score. */
  confidence: number;
  /** Everything else the detector considered, best first. */
  candidates: EncodingCandidate[];
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

/**
 * Decides how to read a subtitle file (spec section 3.1): UTF-8 with or without
 * a byte-order mark, UTF-16 with one, and legacy single-byte code pages
 * detected heuristically.
 */
export function detectEncoding(bytes: Uint8Array): DetectedEncoding {
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

  const candidates = chardet
    .analyse(bytes)
    .map((match) => ({ encoding: match.name.toLowerCase(), confidence: match.confidence }))
    .filter((candidate) => LEGACY.has(candidate.encoding));

  const best =
    candidates.find((candidate) => SPEC_PREFERRED.has(candidate.encoding)) ?? candidates[0];

  return {
    // Windows-1252 is the safest fallback: it is a superset of ISO-8859-1 and
    // never fails to decode, so a file is read imperfectly rather than refused.
    encoding: best?.encoding ?? "windows-1252",
    bom: false,
    confidence: best?.confidence ?? 0,
    candidates,
  };
}

/**
 * Decodes subtitle bytes to text. The returned `encoding` is what the file was,
 * which the document records; everything this product writes back out is UTF-8.
 */
export function decodeSubtitleBytes(
  bytes: Uint8Array,
  options: { encoding?: string } = {},
): { text: string; encoding: string; bom: boolean; confidence: number } {
  const detected = detectEncoding(bytes);
  const encoding = options.encoding ?? detected.encoding;
  const label = iconv.encodingExists(encoding) ? encoding : "windows-1252";
  const text = iconv.decode(bytes, label, { stripBOM: true });
  return {
    text: stripLeadingBom(text),
    encoding: label,
    bom: detected.bom,
    confidence: options.encoding === undefined ? detected.confidence : 100,
  };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
