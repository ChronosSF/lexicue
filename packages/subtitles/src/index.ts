export type { Cue, LineEnding, ParseOptions, SubtitleDocument, SubtitleFormat } from "./types.js";

export {
  DEFAULT_FRAME_RATE,
  MAX_CUES_PER_FILE,
  MAX_FILE_BYTES,
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BYTES,
  MIN_CUES_PER_FILE,
} from "./limits.js";

export {
  FidelityError,
  REJECTION_MESSAGES,
  SubtitleRejectedError,
  type RejectionCode,
} from "./errors.js";

export {
  assertNoImageCompanion,
  assertTextSubtitleBytes,
  detectFormat,
  hasImageCompanion,
  inspectBytes,
} from "./detect.js";

export { parseSubtitleText } from "./parse.js";
export { serialiseSubtitleDocument } from "./serialise.js";
export { assertStructuralFidelity, serialiseAndVerify } from "./verify.js";

export { cueDialogueChars, cuePlainText, documentDialogueChars } from "./chars.js";
export {
  describeMarkup,
  listControlCodes,
  listMarkup,
  listTags,
  markupMultiset,
  markupMultisetsEqual,
  normaliseTag,
  splitLeadingCodes,
  stripMarkup,
  tagMultiset,
  tagMultisetsEqual,
} from "./tags.js";
export { BOM, detectLineEnding, encodeUtf8, splitLines, stripBom } from "./text.js";
export { restoreLines } from "./formats/common.js";
export { isSrtTimingLine, parseSrtTiming } from "./formats/srt.js";
export { isMicroDvdFrameRateLine, isMicroDvdLine } from "./formats/microdvd.js";
export {
  isSubViewerTimingLine,
  parseSubViewerTiming,
  SUBVIEWER_BREAK,
} from "./formats/subviewer.js";
