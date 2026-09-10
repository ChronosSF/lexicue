/** The three subtitle formats supported in v1 (spec section 3.1). */
export type SubtitleFormat = "srt" | "microdvd" | "subviewer";

/** Line ending of the source document, preserved on output. */
export type LineEnding = "\r\n" | "\n";

/**
 * One cue, exactly as described in spec section 4.3.
 *
 * `rawIndexLine` and `rawTimingLine` are copied from the input verbatim and are
 * never re-serialised from `startMs` / `endMs`; that is what makes the fidelity
 * guarantee structural rather than a property of the model.
 */
export interface Cue {
  /** Position in the file, 1-based; this is the id used in the model protocol. */
  id: number;
  /** "1417", copied verbatim; null for formats without an index line. */
  rawIndexLine: string | null;
  /** Copied verbatim, never re-serialised. */
  rawTimingLine: string;
  /** Parsed only for validation and reading-speed metrics. */
  startMs: number;
  endMs: number;
  /**
   * Positioning overrides and control codes stripped from the start of the cue,
   * for example "{\an8}" or "{y:i}". Always equal to `linePrefixCodes[0]`.
   */
  prefixCodes: string;
  /**
   * Codes stripped from the start of each individual line; MicroDVD may put a
   * control code at the start of any line of a cue, so one cue-level string is
   * not enough to re-attach them faithfully.
   * `linePrefixCodes.length === lines.length`. Codes that appear further along a
   * line stay in `lines` and are protected by the markup multiset check instead.
   */
  linePrefixCodes: string[];
  /** The translatable text, inline formatting tags included. */
  lines: string[];
}

/** A parsed subtitle file (spec section 4.3). */
export interface SubtitleDocument {
  format: SubtitleFormat;
  /** As detected, e.g. "utf-8", "windows-1251". */
  encoding: string;
  bom: boolean;
  eol: LineEnding;
  /** SubViewer [INFORMATION] block, MicroDVD frame-rate line, or "". */
  header: string;
  cues: Cue[];
  trailingNewline: boolean;
  /** Billable characters, computed once at parse time (spec sections 4.3, 6.1). */
  dialogueChars: number;
  /** Frames per second for MicroDVD; undefined for the timed formats. */
  frameRate?: number;
  /** Non-fatal observations about a messy input file. */
  warnings: string[];
}

/** Options accepted by the text-level parser. */
export interface ParseOptions {
  /** Force a format instead of detecting one. */
  format?: SubtitleFormat;
  /** Encoding label to record on the document; detection lives in ./encoding. */
  encoding?: string;
  /** Whether the source bytes carried a byte-order mark. */
  bom?: boolean;
  /** File name, used only as a hint for format detection and error messages. */
  fileName?: string;
  /** Frame rate to assume for MicroDVD files without a frame-rate line. */
  defaultFrameRate?: number;
}
