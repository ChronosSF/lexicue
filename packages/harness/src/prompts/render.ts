import type { RepeatedLine } from "../repeats.js";
import type { FileGlossary, SeasonGlossary } from "../schemas.js";
import type { ProtocolCue, TranslationOptions } from "../types.js";

/**
 * How a cue is written for the model: `id<tab>text`, with the cue's own line
 * breaks flattened to a visible marker so that a two-line cue stays one line of
 * the protocol (spec section 4.4).
 *
 * U+23CE was chosen because it is unambiguous: no subtitle file contains it, so
 * splitting an answer back into lines can never cut a line of dialogue in half.
 */
export const LINE_MARKER = "⏎";

/** Splits a translated cue back into lines, accepting either convention. */
export function splitTranslatedLines(text: string): string[] {
  return text.split(/\r?\n|⏎/u);
}

/** Renders one cue as a protocol line. */
export function renderCueLine(cue: ProtocolCue): string {
  return `${cue.id.toString()}\t${cue.lines.join(LINE_MARKER)}`;
}

/**
 * The whole source file as `id<tab>text` lines. This is the block that carries
 * the cache breakpoint, so it must be a pure function of the parsed file: no
 * timestamps, no ordering that depends on a map's insertion order, nothing that
 * could differ between two requests for the same job.
 */
export function renderSourceDocument(cues: readonly ProtocolCue[]): string {
  return cues.map(renderCueLine).join("\n");
}

/**
 * The job's fixed instructions, repeated after the cached prefix.
 *
 * Everything here is per-job by construction — the target language and its
 * spoken-register notes among it — which is why it is rendered after the last
 * cache breakpoint and never into the system prompt (spec sections 4.7, 4.8).
 * Two targets share the prefix bytes exactly; only this block differs.
 */
export function renderJobHeader(options: TranslationOptions): string {
  const lines = [`Target language: ${options.target.name}.`];
  const registerNotes = options.target.spokenRegisterNotes ?? [];
  if (registerNotes.length > 0) {
    lines.push(`The spoken register of ${options.target.name}:`);
    for (const note of registerNotes) lines.push(`- ${note}`);
  }
  if (options.formality === "auto") {
    lines.push(
      "Register: infer it from the dialogue, and keep whatever you infer consistent for the whole file.",
    );
  } else {
    lines.push(
      `Register: ${options.formality}. Use the ${options.formality} form of address throughout unless the dialogue itself marks a change.`,
    );
  }
  lines.push(
    options.lineHandling === "keep-source-line-count"
      ? "Line handling: keep the same number of lines each source cue has."
      : "Line handling: re-flow to at most two lines per cue, breaking at a phrase boundary.",
  );
  if (!options.translateLyrics) {
    lines.push(
      "Song lyrics marked with music notes are left in the source language, notes included.",
    );
  }
  if (options.contextNote.trim() !== "") {
    lines.push(`Context from the user: ${options.contextNote.trim()}`);
  }
  return lines.join("\n");
}

/** Renders a glossary as instructions the batch pass must follow. */
export function renderGlossary(glossary: FileGlossary, label = "Glossary"): string {
  const parts: string[] = [`${label}:`];
  parts.push(`- Source language: ${glossary.sourceLanguage || "unknown"}`);
  parts.push(`- Register: ${glossary.register}`);
  if (glossary.characters.length > 0) {
    parts.push("- Characters:");
    for (const character of glossary.characters) {
      const note = character.notes.trim() === "" ? "" : ` (${character.notes.trim()})`;
      parts.push(`  - ${character.name} -> ${character.rendered}${note}`);
    }
  }
  if (glossary.terms.length > 0) {
    parts.push("- Terms:");
    for (const term of glossary.terms) {
      const note = term.notes.trim() === "" ? "" : ` (${term.notes.trim()})`;
      parts.push(`  - ${term.source} -> ${term.target}${note}`);
    }
  }
  if (glossary.repeatedLines.length > 0) {
    parts.push("- Repeated lines, each with the one rendering to use at every occurrence:");
    for (const line of glossary.repeatedLines) {
      parts.push(`  - ${line.source} -> ${line.target}`);
    }
  }
  if (glossary.cardPatterns.length > 0) {
    parts.push("- Recurring on-screen cards; only the part written {n} changes:");
    for (const card of glossary.cardPatterns) {
      parts.push(`  - ${card.source} -> ${card.target}`);
    }
  }
  if (glossary.styleNotes.length > 0) {
    parts.push("- Style notes:");
    for (const note of glossary.styleNotes) parts.push(`  - ${note}`);
  }
  return parts.join("\n");
}

/**
 * The repeated lines the harness found, listed for the glossary pass to fix a
 * rendering for. They are given rather than asked for because finding them is
 * deterministic (`repeats.ts`) and a model asked to find its own would miss the
 * ones that matter most: the lines whose occurrences fall in different batches.
 */
function renderRepeatedLines(repeated: readonly RepeatedLine[]): string[] {
  if (repeated.length === 0) return [];
  const opening =
    repeated.length === 1
      ? "This line occurs more than once in the source, word for word. Fix exactly one rendering for it"
      : `These ${repeated.length.toString()} lines occur more than once in the source, word for word. Fix exactly one rendering for each`;
  const parts = [
    "",
    `${opening}, and return them under repeatedLines with the source text copied unchanged:`,
  ];
  for (const line of repeated) {
    parts.push(`- (${line.occurrences.toString()}x) ${line.text}`);
  }
  return parts;
}

/** What both glossary passes ask for about recurring on-screen cards. */
const CARD_REQUEST =
  "Under cardPatterns, give every recurring on-screen card — title cards, episode cards, chapter cards, end cards — as one pattern, writing the part that changes from one card to the next as {n} on both sides. One pattern covers the whole set: a card that reads differently in a later file is the fault this exists to prevent.";

/** The one glossary call per file (spec section 4.4). */
export function renderGlossaryRequest(
  options: TranslationOptions,
  seasonGlossary: SeasonGlossary | null,
  repeatedLines: readonly RepeatedLine[] = [],
): string {
  const parts = [
    "Read the whole file above and produce the style sheet for translating it.",
    "",
    renderJobHeader(options),
    "",
    "Return: the detected source language, the register of the dialogue, every character whose name appears with how that name should be written in the target language, every recurring term or piece of invented vocabulary with one fixed translation, and any style notes a translator would need (running jokes, verbal tics, how formal the film is).",
    CARD_REQUEST,
    ...renderRepeatedLines(repeatedLines),
    "",
    "Do not translate any cue yet.",
  ];
  if (seasonGlossary !== null) {
    parts.push(
      "",
      renderGlossary(seasonGlossary, "Season glossary, which you must not contradict"),
      "",
      "You may add characters and terms that appear only in this episode. Do not change a rendering the season glossary already fixes.",
    );
  }
  return parts.join("\n");
}

/** The one call per upload that produces the shared season glossary. */
export function renderSeasonGlossaryRequest(
  options: TranslationOptions,
  repeatedLines: readonly RepeatedLine[] = [],
): string {
  return [
    "Above is a sample of every file in one upload: a season, or a set of related files. Produce the shared style sheet that every file will be translated against.",
    "",
    renderJobHeader(options),
    "",
    "Return: the source language, the register the whole set shares, every recurring character with how the name should be written in the target language, every recurring term with one fixed translation, and the style notes that must hold from the first file to the last (running jokes, catchphrases, forms of address between characters).",
    CARD_REQUEST,
    ...renderRepeatedLines(repeatedLines),
    "",
    "Prefer decisions that will still be right in a later episode you have not seen. Do not translate any cue.",
  ].join("\n");
}

/** One batch of cues to translate (spec section 4.4). */
export function renderBatchRequest(options: {
  glossary: FileGlossary;
  options: TranslationOptions;
  cues: readonly ProtocolCue[];
  /** Validator findings quoted back on a retry (spec section 4.6). */
  findings?: readonly string[];
}): string {
  const ids = options.cues.map((cue) => cue.id);
  const parts = [
    renderJobHeader(options.options),
    "",
    renderGlossary(options.glossary),
    "",
    `Translate exactly these ${ids.length.toString()} cues, and only these. Return one entry per id, with the id unchanged.`,
    "",
    options.cues.map(renderCueLine).join("\n"),
  ];
  if (options.findings !== undefined && options.findings.length > 0) {
    parts.push(
      "",
      "Your previous answer was rejected. Fix exactly these problems and return the cues again:",
      ...options.findings.map((finding) => `- ${finding}`),
    );
  }
  return parts.join("\n");
}
