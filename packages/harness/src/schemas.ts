import { z } from "zod";

/**
 * The structured-output schemas of spec section 4.4. They are handed to the API
 * through `zodOutputFormat`, so the shape of every answer is enforced by the
 * API rather than by parsing prose.
 *
 * No field is optional: structured outputs are strict, and a missing field is
 * far more expensive to handle than an empty string the harness can ignore.
 */

/** One character and how their name is rendered in the target language. */
export const CharacterSchema = z.object({
  name: z.string().describe("The character's name as it appears in the source dialogue"),
  rendered: z.string().describe("How the name must be written in the target language"),
  notes: z
    .string()
    .describe("Gender, address form or register notes; an empty string when there are none"),
});
export type Character = z.infer<typeof CharacterSchema>;

/** A recurring term with the translation every batch must use. */
export const TermSchema = z.object({
  source: z.string().describe("The term as it appears in the source dialogue"),
  target: z.string().describe("The fixed translation to use everywhere"),
  notes: z.string().describe("Why this rendering; an empty string when obvious"),
});
export type Term = z.infer<typeof TermSchema>;

export const RegisterSchema = z.enum(["formal", "informal", "mixed"]);
export type Register = z.infer<typeof RegisterSchema>;

/**
 * The shared style sheet for a multi-file upload (spec section 4.4). It is
 * produced once from a sample of every file and outranks anything a single
 * episode's glossary infers.
 */
export const SeasonGlossarySchema = z.object({
  sourceLanguage: z.string().describe("The language of the source dialogue, as an English name"),
  register: RegisterSchema,
  characters: z.array(CharacterSchema),
  terms: z.array(TermSchema),
  styleNotes: z
    .array(z.string())
    .describe("Running jokes, verbal tics and tone notes that must hold across episodes"),
});
export type SeasonGlossary = z.infer<typeof SeasonGlossarySchema>;

/**
 * The per-file style sheet (spec section 4.4). Same shape as the season
 * glossary: a file glossary may extend the season's, never contradict it, and
 * `mergeGlossaries` enforces that structurally rather than by asking nicely.
 */
export const FileGlossarySchema = SeasonGlossarySchema;
export type FileGlossary = z.infer<typeof FileGlossarySchema>;

/** The answer to one batch of cues (spec section 4.4). */
export const BatchTranslationSchema = z.object({
  cues: z.array(
    z.object({
      i: z.number().int().describe("The cue id exactly as it was given"),
      t: z.string().describe("The translated cue text, with its inline tags"),
    }),
  ),
});
export type BatchTranslation = z.infer<typeof BatchTranslationSchema>;

/** An empty glossary, used when no model has spoken yet. */
export function emptyGlossary(sourceLanguage = ""): FileGlossary {
  return {
    sourceLanguage,
    register: "mixed",
    characters: [],
    terms: [],
    styleNotes: [],
  };
}
