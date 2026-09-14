/** The writing systems the script check knows about (spec section 4.6). */
export type Script =
  "latin" | "cyrillic" | "greek" | "hebrew" | "arabic" | "devanagari" | "thai" | "cjk";

export interface TargetLanguage {
  /** The tag used in the output file name, `original-name.de.srt` (spec section 2.1). */
  code: string;
  /** The English name, which is what the prompt says. */
  name: string;
  script: Script;
  /** True for languages with a T-V distinction, where formality matters. */
  hasFormalityDistinction: boolean;
  /**
   * Where this language's spoken register differs from its written one in a way
   * a model reliably gets wrong, said once, here.
   *
   * These are rendered into the per-job part of the request, never into the
   * system prompt: the prompt is the front of the cached prefix and must stay
   * byte-identical whatever the target is (spec sections 4.7 and 4.8). The
   * general rule — dialogue is speech, write it as it is spoken — lives in the
   * prompt; only the language-specific half lives here.
   *
   * An entry belongs here when an eval has shown the fault, not when it seems
   * likely. German is the one with evidence today.
   */
  spokenRegisterNotes?: readonly string[];
}

/**
 * The curated target list of spec section 3.3. It is a list rather than
 * "anything the model can do" because every entry is meant to have been checked
 * on the evaluation set.
 */
export const TARGET_LANGUAGES: readonly TargetLanguage[] = [
  { code: "en", name: "English", script: "latin", hasFormalityDistinction: false },
  { code: "es", name: "Spanish (Spain)", script: "latin", hasFormalityDistinction: true },
  {
    code: "es-419",
    name: "Spanish (Latin America)",
    script: "latin",
    hasFormalityDistinction: true,
  },
  { code: "pt-BR", name: "Portuguese (Brazil)", script: "latin", hasFormalityDistinction: true },
  { code: "pt-PT", name: "Portuguese (Portugal)", script: "latin", hasFormalityDistinction: true },
  { code: "fr", name: "French", script: "latin", hasFormalityDistinction: true },
  {
    code: "de",
    name: "German",
    script: "latin",
    hasFormalityDistinction: true,
    // The judge and the human read of 14 September 2026 both flagged bookish
    // preterites in spoken lines ("Du sagtest", "Sie blickte") where the
    // surrounding dialogue used the perfect.
    spokenRegisterNotes: [
      'Spoken German uses the perfect for past events, not the preterite: "Du hast das gesagt", not "Du sagtest". The preterite in a spoken line reads as written prose.',
      'The exceptions stay preterite in speech too: sein, haben and the modals ("war", "hatte", "konnte", "wollte", "musste").',
      "A narrative caption or voice-over that the source marks as narration may keep the preterite.",
    ],
  },
  { code: "it", name: "Italian", script: "latin", hasFormalityDistinction: true },
  { code: "nl", name: "Dutch", script: "latin", hasFormalityDistinction: true },
  { code: "pl", name: "Polish", script: "latin", hasFormalityDistinction: true },
  { code: "cs", name: "Czech", script: "latin", hasFormalityDistinction: true },
  { code: "sk", name: "Slovak", script: "latin", hasFormalityDistinction: true },
  { code: "hu", name: "Hungarian", script: "latin", hasFormalityDistinction: true },
  { code: "ro", name: "Romanian", script: "latin", hasFormalityDistinction: true },
  { code: "bg", name: "Bulgarian", script: "cyrillic", hasFormalityDistinction: true },
  { code: "el", name: "Greek", script: "greek", hasFormalityDistinction: true },
  { code: "tr", name: "Turkish", script: "latin", hasFormalityDistinction: true },
  { code: "ru", name: "Russian", script: "cyrillic", hasFormalityDistinction: true },
  { code: "uk", name: "Ukrainian", script: "cyrillic", hasFormalityDistinction: true },
  {
    code: "sr-Cyrl",
    name: "Serbian (Cyrillic)",
    script: "cyrillic",
    hasFormalityDistinction: true,
  },
  { code: "sr-Latn", name: "Serbian (Latin)", script: "latin", hasFormalityDistinction: true },
  { code: "hr", name: "Croatian", script: "latin", hasFormalityDistinction: true },
  { code: "sl", name: "Slovenian", script: "latin", hasFormalityDistinction: true },
  { code: "sv", name: "Swedish", script: "latin", hasFormalityDistinction: false },
  { code: "no", name: "Norwegian", script: "latin", hasFormalityDistinction: false },
  { code: "da", name: "Danish", script: "latin", hasFormalityDistinction: false },
  { code: "fi", name: "Finnish", script: "latin", hasFormalityDistinction: false },
  { code: "et", name: "Estonian", script: "latin", hasFormalityDistinction: true },
  { code: "lv", name: "Latvian", script: "latin", hasFormalityDistinction: true },
  { code: "lt", name: "Lithuanian", script: "latin", hasFormalityDistinction: true },
  { code: "he", name: "Hebrew", script: "hebrew", hasFormalityDistinction: false },
  { code: "ar", name: "Arabic", script: "arabic", hasFormalityDistinction: true },
  { code: "fa", name: "Persian", script: "arabic", hasFormalityDistinction: true },
  { code: "hi", name: "Hindi", script: "devanagari", hasFormalityDistinction: true },
  { code: "th", name: "Thai", script: "thai", hasFormalityDistinction: true },
  { code: "vi", name: "Vietnamese", script: "latin", hasFormalityDistinction: true },
  { code: "id", name: "Indonesian", script: "latin", hasFormalityDistinction: true },
  { code: "ms", name: "Malay", script: "latin", hasFormalityDistinction: true },
  { code: "zh-Hans", name: "Chinese (Simplified)", script: "cjk", hasFormalityDistinction: true },
  { code: "zh-Hant", name: "Chinese (Traditional)", script: "cjk", hasFormalityDistinction: true },
  { code: "ja", name: "Japanese", script: "cjk", hasFormalityDistinction: true },
  { code: "ko", name: "Korean", script: "cjk", hasFormalityDistinction: true },
];

const BY_CODE = new Map(
  TARGET_LANGUAGES.map((language) => [language.code.toLowerCase(), language]),
);
const BY_NAME = new Map(
  TARGET_LANGUAGES.map((language) => [language.name.toLowerCase(), language]),
);

/** Looks a target language up by code ("de") or English name ("German"). */
export function findTargetLanguage(value: string): TargetLanguage | undefined {
  const key = value.trim().toLowerCase();
  return BY_CODE.get(key) ?? BY_NAME.get(key);
}

const SCRIPT_PATTERNS: Record<Script, RegExp> = {
  latin: /\p{Script=Latin}/u,
  cyrillic: /\p{Script=Cyrillic}/u,
  greek: /\p{Script=Greek}/u,
  hebrew: /\p{Script=Hebrew}/u,
  arabic: /\p{Script=Arabic}/u,
  devanagari: /\p{Script=Devanagari}/u,
  thai: /\p{Script=Thai}/u,
  cjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
};

const LETTER = /\p{Letter}/u;

/**
 * The script check of spec section 4.6: for a target in a non-Latin script, a
 * translation whose letters are mostly Latin has not been translated.
 *
 * Proper names legitimately stay in Latin letters, so this only fires when the
 * cue has enough letters to judge and most of them are Latin.
 */
export function looksUntranslated(text: string, script: Script): boolean {
  if (script === "latin") return false;
  const letters = Array.from(text).filter((character) => LETTER.test(character));
  if (letters.length < 6) return false;
  const expected = SCRIPT_PATTERNS[script];
  const inScript = letters.filter((character) => expected.test(character)).length;
  const latin = letters.filter((character) => SCRIPT_PATTERNS.latin.test(character)).length;
  return inScript === 0 && latin / letters.length > 0.5;
}
