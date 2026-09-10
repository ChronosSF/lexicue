import { assertTextSubtitleBytes } from "../detect.js";
import { parseSubtitleText } from "../parse.js";
import { serialiseSubtitleDocument } from "../serialise.js";
import { encodeUtf8 } from "../text.js";
import type { ParseOptions, SubtitleDocument } from "../types.js";
import { decodeSubtitleBytes } from "./detect-encoding.js";

/**
 * The whole read path: refuse image-based and binary files, detect the
 * encoding, decode, then parse. This is what the command-line tool and, later,
 * the worker call.
 */
export function parseSubtitleBytes(
  bytes: Uint8Array,
  options: ParseOptions = {},
): SubtitleDocument {
  assertTextSubtitleBytes(bytes, options.fileName);
  const decoded = decodeSubtitleBytes(
    bytes,
    options.encoding === undefined ? {} : { encoding: options.encoding },
  );
  return parseSubtitleText(decoded.text, {
    ...options,
    encoding: decoded.encoding,
    bom: options.bom ?? decoded.bom,
  });
}

/**
 * The whole write path. Output is always UTF-8 (spec section 3.1); the mark is
 * on by default because it is the safest choice for consumer players, and the
 * caller can turn it off.
 */
export function encodeSubtitleDocument(
  doc: SubtitleDocument,
  options: { bom?: boolean } = {},
): Uint8Array {
  return encodeUtf8(serialiseSubtitleDocument(doc), { bom: options.bom ?? true });
}
