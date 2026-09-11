import { cuePlainText, type SubtitleDocument } from "@lexicue/subtitles";

/**
 * Spec section 3.3 refuses a job whose target language is the language the file
 * is already in, before anything is charged. In the deployed system the source
 * language comes from the glossary pass, which runs after the charge, so the
 * check that matters to the user is this cheap one in front of it.
 *
 * A stopword count is enough: subtitle dialogue is short function words, and the
 * decision only has to be right about the language the user just uploaded, not
 * about every language in the world.
 *
 * It lives in this package because every implementation of the contract has to
 * refuse the same uploads: the mock backend in the browser, the local
 * development API, and the Lambda handlers of Phase 2.
 */

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "you", "that", "is", "it", "not", "of", "to", "what", "we", "he"],
  de: ["der", "die", "das", "und", "ich", "nicht", "ist", "du", "wir", "sie", "ein", "mit"],
  es: ["que", "de", "la", "el", "no", "en", "los", "por", "para", "una", "con", "está"],
  fr: ["le", "la", "les", "des", "que", "pas", "vous", "je", "nous", "est", "une", "pour"],
  it: ["che", "non", "di", "il", "la", "per", "sono", "una", "con", "questo", "come", "mi"],
  pt: ["que", "não", "de", "para", "com", "uma", "você", "está", "isso", "mas", "por", "eles"],
  nl: ["de", "het", "een", "niet", "je", "van", "ik", "dat", "en", "wij", "maar", "voor"],
  pl: [
    "nie",
    "się",
    "jest",
    "tak",
    "ale",
    "jak",
    "tego",
    "czy",
    "przez",
    "tylko",
    "który",
    "jeszcze",
  ],
};

export interface SourceLanguageGuess {
  /** A base language code, or null when nothing scored well enough. */
  code: string | null;
  confidence: number;
}

/** Guesses the language of a parsed document from its dialogue. */
export function guessSourceLanguage(document: SubtitleDocument): SourceLanguageGuess {
  const words = document.cues
    .flatMap((cue) =>
      cuePlainText(cue)
        .toLowerCase()
        .split(/[^\p{L}']+/u),
    )
    .filter((word) => word.length > 0);
  if (words.length === 0) return { code: null, confidence: 0 };

  const counts = new Map<string, number>();
  for (const word of words) {
    for (const [code, stopwords] of Object.entries(STOPWORDS)) {
      if (stopwords.includes(word)) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }

  let best: { code: string; hits: number } | null = null;
  for (const [code, hits] of counts) {
    if (best === null || hits > best.hits) best = { code, hits };
  }
  if (best === null) return { code: null, confidence: 0 };

  const confidence = best.hits / words.length;
  // Below this the guess is noise, and refusing a paid job on noise would be
  // much worse than translating a file into a language it is already in.
  return confidence < 0.02 ? { code: null, confidence } : { code: best.code, confidence };
}

/** The base language of a target code: "pt-BR" and "pt-PT" are both "pt". */
export function baseLanguage(code: string): string {
  const separator = code.indexOf("-");
  return (separator === -1 ? code : code.slice(0, separator)).toLowerCase();
}

/** True when the upload is already in the language it would be translated into. */
export function targetIsSource(targetCode: string, guess: SourceLanguageGuess): boolean {
  return guess.code !== null && baseLanguage(targetCode) === guess.code;
}
