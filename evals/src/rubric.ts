import { z } from "zod";

/**
 * The judge's rubric is frozen text with a version, exactly as the translation
 * prompts are (spec sections 9.8 and 10.4). Changing it changes the version, so
 * a score is always comparable with the scores taken under the same rubric.
 */
export const RUBRIC_VERSION = "subtitle-translator/judge@v1";

export const JUDGE_RUBRIC = `You are grading subtitle translations. You see the source cue and the translation, with the surrounding cues for context, and you score each one on four axes from 1 to 5.

ACCURACY
5 - Everything the source says is in the translation, and nothing else is.
4 - A small nuance is lost or added; a viewer would not notice.
3 - A detail is wrong, or an implication has changed.
2 - A clause is missing, invented, or reversed.
1 - The translation is about something else.

NATURALNESS
5 - A person in the target language would say exactly this, in this situation.
4 - Slightly written rather than spoken, but unremarkable on screen.
3 - Understandable but stiff; the source's word order shows through.
2 - Clumsy enough to pull attention away from the picture.
1 - Not idiomatic; reads as machine output.

REGISTER
5 - The formality, warmth and rudeness of the source are all preserved, and the
    form of address matches the relationship between these characters.
4 - One small slip in politeness or contraction.
3 - The register drifts: a casual line reads formally, or the reverse.
2 - The form of address contradicts what the same pair used earlier.
1 - The register is wrong throughout.

NAME CONSISTENCY
5 - Every name, place and recurring term is rendered as the glossary says.
4 - A name is inflected in a way the glossary did not cover, but consistently.
3 - A recurring term is translated two different ways.
2 - A character's name is changed or translated when it should not be.
1 - Names are unrecognisable from one cue to the next.

Judge the translation as a subtitle, not as prose: it is read in under three
seconds while a picture is moving. Brevity that keeps the meaning is a virtue,
not a loss of accuracy. Do not reward padding.

Give one short note only where a score is 3 or below, saying what a translator
would have to change.`;

export const CueVerdictSchema = z.object({
  i: z.number().int().describe("The cue id being scored"),
  accuracy: z.number().int().min(1).max(5),
  naturalness: z.number().int().min(1).max(5),
  register: z.number().int().min(1).max(5),
  nameConsistency: z.number().int().min(1).max(5),
  note: z.string().describe("A short note when any score is 3 or below, else an empty string"),
});
export type CueVerdict = z.infer<typeof CueVerdictSchema>;

export const JudgementSchema = z.object({
  verdicts: z.array(CueVerdictSchema),
  summary: z.string().describe("One or two sentences on the translation as a whole"),
});
export type Judgement = z.infer<typeof JudgementSchema>;

/**
 * The cross-episode check of spec section 10.4: the same name renderings and
 * the same form of address in every episode of a season.
 */
export const SeasonConsistencySchema = z.object({
  consistent: z.boolean(),
  findings: z
    .array(z.string())
    .describe("Anything rendered differently between episodes; empty when consistent"),
});
export type SeasonConsistency = z.infer<typeof SeasonConsistencySchema>;

/** The four axes, in the order the report prints them. */
export const AXES = ["accuracy", "naturalness", "register", "nameConsistency"] as const;
export type Axis = (typeof AXES)[number];
