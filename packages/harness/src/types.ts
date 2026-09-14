import type { Lane } from "@lexicue/pricing";
import type { Cue, SubtitleDocument } from "@lexicue/subtitles";
import type { TargetLanguage } from "./languages.js";

export type Formality = "auto" | "formal" | "informal";
export type LineHandling = "reflow" | "keep-source-line-count";

/** The user's choices for one upload (spec section 3.4). */
export interface TranslationOptions {
  target: TargetLanguage;
  lane: Lane;
  formality: Formality;
  /** Free text, at most 500 characters, appended to the glossary. */
  contextNote: string;
  lineHandling: LineHandling;
  /** Whether song lyrics under music notes are translated. */
  translateLyrics: boolean;
}

/** One file to translate. */
export interface TranslationJob {
  /**
   * Used in Message Batch custom ids as `{jobId}_{batchIndex}`. The separator
   * is an underscore, not the colon spec section 4.5 asks for: the API accepts
   * only `^[a-zA-Z0-9_-]{1,64}$` and rejects the whole batch otherwise, so the
   * job id must fit that set too. See `CUSTOM_ID_PATTERN` in batches.ts.
   */
  jobId: string;
  fileName: string;
  document: SubtitleDocument;
}

/** A cue as the model protocol sees it: an id and the text of its lines. */
export interface ProtocolCue {
  id: number;
  lines: string[];
}

/** Reduces a parsed cue to what the model is allowed to see. */
export function toProtocolCue(cue: Cue): ProtocolCue {
  return { id: cue.id, lines: cue.lines };
}

export const MAX_CONTEXT_NOTE_LENGTH = 500;
