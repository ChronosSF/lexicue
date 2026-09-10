import { SubtitleRejectedError, type RejectionCode } from "./errors.js";
import { isMicroDvdLine } from "./formats/microdvd.js";
import { isSrtTimingLine } from "./formats/srt.js";
import { isSubViewerTimingLine } from "./formats/subviewer.js";
import { MAX_FILE_BYTES } from "./limits.js";
import { splitLines } from "./text.js";
import type { SubtitleFormat } from "./types.js";

const SCAN_BYTES = 8192;

/**
 * Refuses image-based and binary files before anything tries to decode them
 * (spec section 3.1). Works on bytes only, so it is safe in the browser.
 */
export function inspectBytes(bytes: Uint8Array, fileName?: string): RejectionCode | null {
  if (bytes.length === 0) return "empty";
  if (bytes.length > MAX_FILE_BYTES) return "too-large";
  if (isVobSub(bytes) || isPgs(bytes, fileName)) return "image-based";
  if (hasNulByte(bytes)) return "binary";
  return null;
}

/** Throws the user-facing rejection for bytes that are not a text subtitle file. */
export function assertTextSubtitleBytes(bytes: Uint8Array, fileName?: string): void {
  const code = inspectBytes(bytes, fileName);
  if (code !== null) throw new SubtitleRejectedError(code, fileName);
}

/**
 * A `.sub` next to a `.idx` is a VobSub pair: pictures of text, nothing to
 * translate. The sibling list comes from the upload or the directory listing.
 */
export function hasImageCompanion(fileName: string, siblingNames: readonly string[]): boolean {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith(".sub")) return false;
  const stem = lower.slice(0, -4);
  return siblingNames.some((name) => name.toLowerCase() === `${stem}.idx`);
}

/** Throws the image-based rejection when the file has a VobSub `.idx` companion. */
export function assertNoImageCompanion(fileName: string, siblingNames: readonly string[]): void {
  if (hasImageCompanion(fileName, siblingNames)) {
    throw new SubtitleRejectedError("image-based", fileName);
  }
}

/**
 * Decides the format from the content. The file name is only a tie-breaker,
 * because both `.sub` dialects share an extension and real files are often
 * misnamed.
 */
export function detectFormat(text: string, fileName?: string): SubtitleFormat | null {
  const lines = splitLines(text).slice(0, 400);
  let srt = 0;
  let microdvd = 0;
  let subviewer = 0;
  for (const line of lines) {
    if (isSrtTimingLine(line)) srt += 1;
    else if (isSubViewerTimingLine(line)) subviewer += 1;
    else if (isMicroDvdLine(line)) microdvd += 1;
  }
  if (srt > 0 && srt >= subviewer && srt >= microdvd) return "srt";
  if (subviewer > 0 && subviewer >= microdvd) return "subviewer";
  if (microdvd > 0) return "microdvd";
  if (/^\s*\[INFORMATION\]/im.test(text)) return "subviewer";
  return extensionHint(fileName) === "srt" && /-{1,3}>/.test(text) ? "srt" : null;
}

function extensionHint(fileName: string | undefined): "srt" | "sub" | null {
  if (fileName === undefined) return null;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".srt")) return "srt";
  if (lower.endsWith(".sub")) return "sub";
  return null;
}

function isVobSub(bytes: Uint8Array): boolean {
  // MPEG program stream pack header, which is what a VobSub `.sub` starts with.
  return bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0xba;
}

function isPgs(bytes: Uint8Array, fileName?: string): boolean {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x47) return false; // "PG"
  if (fileName?.toLowerCase().endsWith(".sup") === true) return true;
  return bytes.subarray(2, 16).includes(0x00);
}

function hasNulByte(bytes: Uint8Array): boolean {
  const start = utf16BomLength(bytes);
  if (start > 0) return false; // UTF-16 text legitimately contains NUL bytes.
  const end = Math.min(bytes.length, SCAN_BYTES);
  for (let i = start; i < end; i += 1) {
    if (bytes[i] === 0x00) return true;
  }
  return false;
}

function utf16BomLength(bytes: Uint8Array): number {
  const isLe = bytes[0] === 0xff && bytes[1] === 0xfe;
  const isBe = bytes[0] === 0xfe && bytes[1] === 0xff;
  return isLe || isBe ? 2 : 0;
}
