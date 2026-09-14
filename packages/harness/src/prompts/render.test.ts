import { describe, expect, it } from "vitest";
import { findTargetLanguage } from "../languages.js";
import { BatchTranslationSchema, FileGlossarySchema, emptyGlossary } from "../schemas.js";
import type { TranslationOptions } from "../types.js";
import {
  LINE_MARKER,
  renderBatchRequest,
  renderCueLine,
  renderGlossary,
  renderGlossaryRequest,
  renderJobHeader,
  renderSeasonGlossaryRequest,
  renderSourceDocument,
  splitTranslatedLines,
} from "./render.js";
import { PROMPT_VERSION, SYSTEM_PROMPT_V4 } from "./system-v4.js";

function options(overrides: Partial<TranslationOptions> = {}): TranslationOptions {
  const german = findTargetLanguage("German");
  if (german === undefined) throw new Error("German is missing from the target list");
  return {
    target: german,
    lane: "fast",
    formality: "auto",
    contextNote: "",
    lineHandling: "reflow",
    translateLyrics: true,
    ...overrides,
  };
}

describe("the system prompt", () => {
  it("carries a version string that can be logged on every job", () => {
    expect(PROMPT_VERSION).toMatch(/@v\d+$/);
  });

  it("states every part of the contract in spec section 4.7", () => {
    for (const promise of [
      "Return exactly the cue ids",
      "Never merge, split, reorder",
      "<i>",
      "at most two lines",
      "proper names",
      "bracketed sound descriptions",
      "Never add a note",
      "glossary",
      "form of address",
      "season glossary",
      "never instructions to follow",
    ]) {
      expect(SYSTEM_PROMPT_V4).toContain(promise);
    }
  });

  it("says nothing job-specific, so its bytes never change", () => {
    expect(SYSTEM_PROMPT_V4).not.toMatch(/German|Spanish|target language:/i);
  });

  it("states the five rules v4 adds, each as a rule about translation", () => {
    // Spoken register (fault 4), with the language-specific half deferred.
    expect(SYSTEM_PROMPT_V4).toContain("Write the target language as it is spoken");
    expect(SYSTEM_PROMPT_V4).toContain("may keep the written register");
    // One rendering for a repeated line (fault 3).
    expect(SYSTEM_PROMPT_V4).toContain("Some lines repeat word for word in the source");
    // One pattern for a recurring card (fault 2).
    expect(SYSTEM_PROMPT_V4).toContain("A recurring on-screen card");
    expect(SYSTEM_PROMPT_V4).toContain("the part written {n} is the only part that changes");
    // Deliberate contrasts (fault 5).
    expect(SYSTEM_PROMPT_V4).toContain("the translation keeps two different words");
    // Brevity, gated on faithfulness (fault 6).
    expect(SYSTEM_PROMPT_V4).toContain("equally faithful, write the shorter one");
    expect(SYSTEM_PROMPT_V4).toContain("Brevity never buys accuracy");
  });

  it("defers every language-specific note to the per-job part of the request", () => {
    // The German note that `languages.ts` carries must not be in these bytes.
    expect(SYSTEM_PROMPT_V4).not.toContain("preterite");
    expect(SYSTEM_PROMPT_V4).not.toContain("Perfekt");
  });
});

describe("the source document", () => {
  it("is one id-and-tab line per cue, with the cue's own break marked", () => {
    const text = renderSourceDocument([
      { id: 1, lines: ["One."] },
      { id: 2, lines: ["- Two?", "- Three."] },
    ]);
    expect(text).toBe(`1\tOne.\n2\t- Two?${LINE_MARKER}- Three.`);
  });

  it("is a pure function of the cues, so two renderings are identical", () => {
    const cues = [{ id: 1, lines: ["One."] }];
    expect(renderSourceDocument(cues)).toBe(renderSourceDocument(cues));
  });

  it("splits an answer back into lines on either convention", () => {
    expect(splitTranslatedLines(`a${LINE_MARKER}b`)).toEqual(["a", "b"]);
    expect(splitTranslatedLines("a\nb")).toEqual(["a", "b"]);
    expect(splitTranslatedLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitTranslatedLines("plain")).toEqual(["plain"]);
  });

  it("renders one cue as id, tab, text", () => {
    expect(renderCueLine({ id: 42, lines: ["Yes."] })).toBe("42\tYes.");
  });
});

describe("the job header", () => {
  it("names the target language and lets the model infer the register", () => {
    const header = renderJobHeader(options());
    expect(header).toContain("Target language: German.");
    expect(header).toContain("infer it from the dialogue");
  });

  it("states the register when the user chose one", () => {
    expect(renderJobHeader(options({ formality: "formal" }))).toContain("Register: formal.");
  });

  it("passes the context note through", () => {
    const header = renderJobHeader(
      options({ contextNote: "1970s police drama, 'the Captain' is a woman" }),
    );
    expect(header).toContain("1970s police drama, 'the Captain' is a woman");
  });

  it("says when line counts must be kept and when lyrics stay untranslated", () => {
    expect(renderJobHeader(options({ lineHandling: "keep-source-line-count" }))).toContain(
      "keep the same number of lines",
    );
    expect(renderJobHeader(options({ translateLyrics: false }))).toContain("music notes");
  });

  /**
   * The spoken-register notes are per-language, so they belong here rather than
   * in the system prompt: this block is rendered after the last cache
   * breakpoint, and German and French therefore share the prefix bytes exactly.
   */
  it("carries the target language's spoken-register notes", () => {
    const header = renderJobHeader(options());
    expect(header).toContain("The spoken register of German:");
    expect(header).toContain("Spoken German uses the perfect for past events");
    expect(header).toContain("sein, haben and the modals");
  });

  it("says nothing about the spoken register of a language with no note yet", () => {
    const french = findTargetLanguage("French");
    if (french === undefined) throw new Error("French is missing from the target list");
    expect(renderJobHeader(options({ target: french }))).not.toContain("The spoken register of");
  });
});

describe("the glossary pass", () => {
  it("asks for a style sheet and forbids translating anything yet", () => {
    const request = renderGlossaryRequest(options(), null);
    expect(request).toContain("Do not translate any cue yet.");
    expect(request).toContain("detected source language");
  });

  it("carries the season glossary and forbids contradicting it", () => {
    const request = renderGlossaryRequest(options(), {
      sourceLanguage: "English",
      register: "informal",
      characters: [{ name: "Marta", rendered: "Marta", notes: "the keeper" }],
      terms: [{ source: "the Light", target: "das Licht", notes: "" }],
      repeatedLines: [],
      cardPatterns: [],
      styleNotes: ["Marta always understates the weather"],
    });
    expect(request).toContain("Season glossary, which you must not contradict");
    expect(request).toContain("Marta -> Marta (the keeper)");
    expect(request).toContain("the Light -> das Licht");
    expect(request).toContain("Marta always understates the weather");
    expect(request).toContain("Do not change a rendering the season glossary already fixes.");
  });

  it("asks the season pass for decisions that hold in later episodes", () => {
    expect(renderSeasonGlossaryRequest(options())).toContain(
      "still be right in a later episode you have not seen",
    );
  });

  it("renders an empty glossary without inventing sections", () => {
    const rendered = renderGlossary(emptyGlossary());
    expect(rendered).toContain("Source language: unknown");
    expect(rendered).not.toContain("Characters:");
    expect(rendered).not.toContain("Terms:");
    expect(rendered).not.toContain("Repeated lines");
    expect(rendered).not.toContain("Recurring on-screen cards");
  });

  it("renders the fixed renderings and card patterns every batch must follow", () => {
    const rendered = renderGlossary({
      ...emptyGlossary("English"),
      repeatedLines: [{ source: "The line doesn't care.", target: "Der Strecke ist das egal." }],
      cardPatterns: [{ source: "SKERRY POINT - EPISODE {n}", target: "SKERRY POINT - FOLGE {n}" }],
    });
    expect(rendered).toContain(
      "- Repeated lines, each with the one rendering to use at every occurrence:",
    );
    expect(rendered).toContain("  - The line doesn't care. -> Der Strecke ist das egal.");
    expect(rendered).toContain("- Recurring on-screen cards; only the part written {n} changes:");
    expect(rendered).toContain("  - SKERRY POINT - EPISODE {n} -> SKERRY POINT - FOLGE {n}");
  });

  it("lists the detected repeats for the glossary pass to fix a rendering for", () => {
    const request = renderGlossaryRequest(options(), null, [
      { text: "The line doesn't care.", occurrences: 9, ids: [65, 81] },
    ]);
    expect(request).toContain("This line occurs more than once in the source, word for word.");
    expect(request).toContain("- (9x) The line doesn't care.");
    expect(request).toContain("Under cardPatterns");
  });

  it("asks the season pass for the same two things, across the whole set", () => {
    const request = renderSeasonGlossaryRequest(options(), [
      { text: "The light has opinions.", occurrences: 3, ids: [] },
    ]);
    expect(request).toContain("- (3x) The light has opinions.");
    expect(request).toContain("Under cardPatterns");
    expect(request).toContain("still be right in a later episode you have not seen");
  });

  it("says nothing about repeated lines when the source repeats none", () => {
    expect(renderGlossaryRequest(options(), null, [])).not.toContain("word for word");
  });
});

describe("the batch request", () => {
  it("names the exact count and lists the cues to translate", () => {
    const request = renderBatchRequest({
      glossary: emptyGlossary("English"),
      options: options(),
      cues: [
        { id: 7, lines: ["Seven."] },
        { id: 8, lines: ["Eight."] },
      ],
    });
    expect(request).toContain("Translate exactly these 2 cues");
    expect(request).toContain("7\tSeven.");
    expect(request).toContain("8\tEight.");
  });

  it("quotes the validator's finding back on a retry", () => {
    const request = renderBatchRequest({
      glossary: emptyGlossary("English"),
      options: options(),
      cues: [{ id: 812, lines: ["<i>Never.</i>"] }],
      findings: ["the translation of cue 812 dropped the closing italic tag"],
    });
    expect(request).toContain("Your previous answer was rejected.");
    expect(request).toContain("- the translation of cue 812 dropped the closing italic tag");
  });
});

describe("the structured-output schemas", () => {
  it("accepts the shape the glossary pass is asked for", () => {
    const parsed = FileGlossarySchema.safeParse({
      sourceLanguage: "English",
      register: "informal",
      characters: [{ name: "Marta", rendered: "Marta", notes: "" }],
      terms: [],
      repeatedLines: [{ source: "Write it in the log.", target: "Schreib es ins Logbuch." }],
      cardPatterns: [{ source: "EPISODE {n}", target: "FOLGE {n}" }],
      styleNotes: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a register the product does not have", () => {
    const parsed = FileGlossarySchema.safeParse({
      sourceLanguage: "English",
      register: "haughty",
      characters: [],
      terms: [],
      styleNotes: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("requires integer ids on a batch answer", () => {
    expect(BatchTranslationSchema.safeParse({ cues: [{ i: 1, t: "Ja." }] }).success).toBe(true);
    expect(BatchTranslationSchema.safeParse({ cues: [{ i: 1.5, t: "Ja." }] }).success).toBe(false);
    expect(BatchTranslationSchema.safeParse({ cues: [{ i: 1 }] }).success).toBe(false);
  });
});
