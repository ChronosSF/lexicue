import { serialiseMicroDvd } from "./formats/microdvd.js";
import { serialiseSrt } from "./formats/srt.js";
import { serialiseSubViewer } from "./formats/subviewer.js";
import type { SubtitleDocument } from "./types.js";

/**
 * The inverse of {@link parseSubtitleText}: header, then for each cue the raw
 * index line, the raw timing line and the protected codes plus the (translated)
 * lines, joined with the document's own line ending.
 */
export function serialiseSubtitleDocument(doc: SubtitleDocument): string {
  switch (doc.format) {
    case "srt":
      return serialiseSrt(doc);
    case "microdvd":
      return serialiseMicroDvd(doc);
    case "subviewer":
      return serialiseSubViewer(doc);
  }
}
