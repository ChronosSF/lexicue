import { MAX_CUES_PER_FILE, MAX_FILE_BYTES } from "./limits.js";

/** Why a file was refused. Each maps to one user-facing sentence. */
export type RejectionCode =
  "image-based" | "binary" | "unknown-format" | "empty" | "no-cues" | "too-many-cues" | "too-large";

/**
 * The exact sentences the user sees. They live here so the browser preview,
 * the API and the tests all quote the same words (spec sections 2.1, 10.1).
 */
export const REJECTION_MESSAGES = {
  "image-based":
    "This is an image-based subtitle file (VobSub or PGS). Image-based subtitles contain pictures of text, not text, so there is nothing to translate.",
  binary:
    "This file is not a text subtitle file. Upload SubRip (.srt), MicroDVD (.sub) or SubViewer (.sub).",
  "unknown-format":
    "This file's format was not recognised. Upload SubRip (.srt), MicroDVD (.sub) or SubViewer (.sub).",
  empty: "This file is empty.",
  "no-cues": "No subtitles were found in this file.",
  "too-many-cues": `This file has more than ${MAX_CUES_PER_FILE.toLocaleString("en-US")} cues. Split it into parts and upload them separately.`,
  "too-large": `This file is larger than ${(MAX_FILE_BYTES / (1024 * 1024)).toString()} MB. Split it into parts and upload them separately.`,
} as const satisfies Record<RejectionCode, string>;

/** A file the product refuses, with the sentence to show for it. */
export class SubtitleRejectedError extends Error {
  readonly code: RejectionCode;
  readonly fileName: string | undefined;

  constructor(code: RejectionCode, fileName?: string) {
    super(REJECTION_MESSAGES[code]);
    this.name = "SubtitleRejectedError";
    this.code = code;
    this.fileName = fileName;
  }
}

/**
 * Thrown when the harness re-parses its own output and finds it does not match
 * the input (spec section 4.1). It always means a bug in this package or in the
 * harness, never a bad model answer, so it fails the file rather than degrading it.
 */
export class FidelityError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Structural fidelity check failed: ${detail}`);
    this.name = "FidelityError";
    this.detail = detail;
  }
}
