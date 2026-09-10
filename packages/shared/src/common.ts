import { LANES } from "@subtitle-translator/pricing";
import { z } from "zod";

/**
 * The vocabulary every route in spec section 7.3 shares. All money is integer
 * cents (spec section 7.4); nothing in the contract ever carries a float.
 */

/** Integer cents, never negative. */
export const CentsSchema = z.int().min(0);

/** A signed movement of money: a charge is negative, a top-up positive. */
export const DeltaCentsSchema = z.int();

/** ULIDs in the deployed system; any non-empty opaque string here. */
export const IdSchema = z.string().min(1);

/** An ISO 8601 instant, which is how every timestamp crosses the wire. */
export const InstantSchema = z.iso.datetime();

export const LaneSchema = z.enum(LANES);

export const FormalitySchema = z.enum(["auto", "formal", "informal"]);

export const LineHandlingSchema = z.enum(["reflow", "keep-source-line-count"]);

export const SubtitleFormatSchema = z.enum(["srt", "microdvd", "subviewer"]);

/** Spec section 3.4, plus the output encoding choice of section 3.1. */
export const TranslationOptionsSchema = z.object({
  formality: FormalitySchema,
  /** Free text, at most 500 characters, appended to the glossary. */
  contextNote: z.string().max(500),
  lineHandling: LineHandlingSchema,
  /** Whether song lyrics under music notes are translated. */
  translateLyrics: z.boolean(),
  /** UTF-8 with a byte-order mark is the default; the user can turn it off. */
  outputBom: z.boolean(),
});

export type Lane = z.infer<typeof LaneSchema>;
export type Formality = z.infer<typeof FormalitySchema>;
export type LineHandling = z.infer<typeof LineHandlingSchema>;
export type SubtitleFormat = z.infer<typeof SubtitleFormatSchema>;
export type TranslationOptions = z.infer<typeof TranslationOptionsSchema>;

/** The options a new upload starts with. */
export const DEFAULT_TRANSLATION_OPTIONS: TranslationOptions = {
  formality: "auto",
  contextNote: "",
  lineHandling: "reflow",
  translateLyrics: true,
  outputBom: true,
};
