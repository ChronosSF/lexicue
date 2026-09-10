import { describe, expect, it } from "vitest";
import { DEFAULT_HARNESS_CONFIG, resolveConfig } from "./config.js";
import { findTargetLanguage, looksUntranslated, type TargetLanguage } from "./languages.js";
import { matchLineCount, reflowLines, rewrapWithSourceTags } from "./reflow.js";
import type { LineHandling, ProtocolCue } from "./types.js";
import { validateBatch } from "./validate.js";

function language(code: string): TargetLanguage {
  const found = findTargetLanguage(code);
  if (found === undefined) throw new Error(`unknown language ${code}`);
  return found;
}

function run(
  sourceCues: ProtocolCue[],
  answers: { i: number; t: string }[],
  options: { target?: string; lineHandling?: LineHandling; maxLines?: number } = {},
): ReturnType<typeof validateBatch> {
  return validateBatch({
    sourceCues,
    answers,
    target: language(options.target ?? "de"),
    config:
      options.maxLines === undefined
        ? DEFAULT_HARNESS_CONFIG
        : resolveConfig({ maxLinesPerCue: options.maxLines }),
    lineHandling: options.lineHandling ?? "reflow",
  });
}

const ONE: ProtocolCue[] = [{ id: 1, lines: ["Hello there."] }];

describe("coverage", () => {
  it("accepts an answer that returns exactly the ids it was asked for", () => {
    const result = run(ONE, [{ i: 1, t: "Hallo." }]);
    expect(result.failures).toEqual([]);
    expect(result.accepted.get(1)).toEqual(["Hallo."]);
  });

  it("fails a missing id and says which one", () => {
    const result = run(
      [
        { id: 1, lines: ["One."] },
        { id: 2, lines: ["Two."] },
      ],
      [{ i: 1, t: "Eins." }],
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.id).toBe(2);
    expect(result.failures[0]?.finding).toMatch(/cue 2 was missing/);
  });

  it("fails a duplicated id rather than guessing which copy is meant", () => {
    const result = run(ONE, [
      { i: 1, t: "Hallo." },
      { i: 1, t: "Guten Tag." },
    ]);
    expect(result.accepted.size).toBe(0);
    expect(result.failures[0]?.finding).toMatch(/returned more than once/);
  });

  it("drops an id nobody asked for and warns about it", () => {
    const result = run(ONE, [
      { i: 1, t: "Hallo." },
      { i: 99, t: "Wo kommt das her?" },
    ]);
    expect(result.accepted.size).toBe(1);
    expect(result.warnings[0]).toMatch(/Dropped cue 99/);
  });
});

describe("emptiness", () => {
  it("fails a non-empty cue that came back empty", () => {
    expect(run(ONE, [{ i: 1, t: "" }]).failures[0]?.finding).toMatch(/came back empty/);
    expect(run(ONE, [{ i: 1, t: "   " }]).failures[0]?.finding).toMatch(/came back empty/);
  });

  it("leaves a cue that had no dialogue alone", () => {
    const result = run([{ id: 1, lines: [] }], [{ i: 1, t: "" }]);
    expect(result.failures).toEqual([]);
    expect(result.accepted.get(1)).toEqual([]);
  });
});

describe("tags", () => {
  it("accepts a translation with the same tags in a different order", () => {
    const source: ProtocolCue[] = [{ id: 1, lines: ["<i>Yes</i> and <b>no</b>"] }];
    const result = run(source, [{ i: 1, t: "<b>Nein</b> und <i>ja</i>" }]);
    expect(result.failures).toEqual([]);
  });

  it("re-wraps a cue whose tags only wrapped the whole line", () => {
    const source: ProtocolCue[] = [{ id: 1, lines: ["<i>Never.</i>"] }];
    const result = run(source, [{ i: 1, t: "Niemals." }]);
    expect(result.failures).toEqual([]);
    expect(result.accepted.get(1)).toEqual(["<i>Niemals.</i>"]);
    expect(result.repairs[0]).toMatch(/re-wrapped/);
  });

  it("retries a cue whose tags are wrong in a way no re-wrap can fix", () => {
    const source: ProtocolCue[] = [{ id: 1, lines: ["A <i>bold</i> claim"] }];
    const result = run(source, [{ i: 1, t: "Eine kühne Behauptung" }]);
    expect(result.failures[0]?.finding).toMatch(/wrong tags/);
    expect(result.failures[0]?.finding).toMatch(/<i> <\/i>/);
  });

  it("strips a tag the translation invented, restoring the source's multiset", () => {
    const result = run(ONE, [{ i: 1, t: "<i>Hallo.</i>" }]);
    expect(result.failures).toEqual([]);
    expect(result.accepted.get(1)).toEqual(["Hallo."]);
    expect(result.repairs[0]).toMatch(/re-wrapped/);
  });

  it("re-attaches a control code the translation dropped, after the speaker dash", () => {
    const source: ProtocolCue[] = [{ id: 1, lines: ["- {y:i}Never."] }];
    const result = run(source, [{ i: 1, t: "- Niemals." }]);
    expect(result.failures).toEqual([]);
    expect(result.accepted.get(1)).toEqual(["- {y:i}Niemals."]);
  });

  it("retries when a dropped code cannot be put back unambiguously", () => {
    const source: ProtocolCue[] = [{ id: 1, lines: ["Blue {c:$0000ff}and{c:$ffffff} white."] }];
    const result = run(source, [{ i: 1, t: "Blau und weiß." }]);
    expect(result.failures[0]?.finding).toMatch(/wrong tags/);
  });
});

describe("line count", () => {
  it("re-flows an answer with too many lines instead of failing it", () => {
    const result = run(ONE, [{ i: 1, t: "Eins.\nZwei.\nDrei." }]);
    expect(result.failures).toEqual([]);
    expect(result.accepted.get(1)).toHaveLength(2);
    expect(result.repairs[0]).toMatch(/re-flowed/);
  });

  it("allows more lines when the source cue had more", () => {
    const source: ProtocolCue[] = [{ id: 1, lines: ["A", "B", "C"] }];
    const result = run(source, [{ i: 1, t: "Eins.\nZwei.\nDrei." }]);
    expect(result.accepted.get(1)).toHaveLength(3);
    expect(result.repairs).toEqual([]);
  });

  it("forces the source's line count when the user asked for that", () => {
    const source: ProtocolCue[] = [{ id: 1, lines: ["A one-line cue."] }];
    const result = run(source, [{ i: 1, t: "Eins.\nZwei." }], {
      lineHandling: "keep-source-line-count",
    });
    expect(result.accepted.get(1)).toEqual(["Eins. Zwei."]);
  });
});

describe("the script check", () => {
  it("fails a Latin answer for a Cyrillic target", () => {
    const result = run(ONE, [{ i: 1, t: "Hello there." }], { target: "bg" });
    expect(result.failures[0]?.finding).toMatch(/came back in Latin letters/);
  });

  it("accepts a Cyrillic answer for a Cyrillic target", () => {
    const result = run(ONE, [{ i: 1, t: "Здравейте." }], { target: "bg" });
    expect(result.failures).toEqual([]);
  });

  it("does not fail a short cue that is only a name", () => {
    expect(looksUntranslated("Marta", "cyrillic")).toBe(false);
    expect(looksUntranslated("Здравей, Marta", "cyrillic")).toBe(false);
  });

  it("never fires for a Latin target", () => {
    expect(looksUntranslated("Hello there, my friend.", "latin")).toBe(false);
  });

  it("flags, but does not fail, a Latin batch that came back unchanged", () => {
    const cues: ProtocolCue[] = Array.from({ length: 6 }, (_unused, index) => ({
      id: index + 1,
      lines: [`Line ${(index + 1).toString()}.`],
    }));
    const result = run(
      cues,
      cues.map((cue) => ({ i: cue.id, t: cue.lines.join(" ") })),
    );
    expect(result.failures).toEqual([]);
    expect(result.warnings[0]).toMatch(/identical to the source/);
  });
});

describe("leakage", () => {
  it.each([
    ["a cue id and a tab", "1\tHallo."],
    ["a translator's note", "Hallo. (translator's note: unclear)"],
    ["a placeholder marker", "[[NAME]] ist hier."],
    ["a note to the reader", "Note: this line is ambiguous."],
    ["the JSON keys of the protocol", 'Hallo. {"i": 1, "t": "x"}'],
    ["a timing line", "00:00:01,000 --> 00:00:02,000"],
  ])("fails an answer that leaked %s", (_why, text) => {
    const result = run(ONE, [{ i: 1, t: text }]);
    expect(result.failures[0]?.finding).toMatch(/return the translated dialogue only/);
  });

  it("does not mistake ordinary dialogue for leakage", () => {
    const result = run(ONE, [{ i: 1, t: "Er sagte: Komm um 3." }]);
    expect(result.failures).toEqual([]);
  });
});

describe("reflowLines", () => {
  it("leaves a cue that already fits", () => {
    expect(reflowLines(["One.", "Two."], 2)).toEqual(["One.", "Two."]);
  });

  it("breaks at punctuation rather than mid-phrase", () => {
    const out = reflowLines(["I told him no.", "He asked again.", "So I left."], 2);
    expect(out).toHaveLength(2);
    expect(out[0]?.endsWith(".")).toBe(true);
  });

  it("collapses to one line when asked", () => {
    expect(reflowLines(["A.", "B.", "C."], 1)).toEqual(["A. B. C."]);
  });

  it("refuses a line count below one", () => {
    expect(() => reflowLines(["a"], 0)).toThrow(RangeError);
  });

  it("matches a required line count exactly, in both directions", () => {
    expect(matchLineCount(["A. B. C. D."], 2)).toHaveLength(2);
    expect(matchLineCount(["A.", "B.", "C."], 2)).toHaveLength(2);
    expect(matchLineCount(["Only one."], 3)).toHaveLength(3);
  });
});

describe("rewrapWithSourceTags", () => {
  it("puts the source's outer tags back around a stripped translation", () => {
    expect(rewrapWithSourceTags(["<i>Never.</i>"], ["Niemals."])).toEqual(["<i>Niemals.</i>"]);
  });

  it("handles one wrapped line and one plain line", () => {
    expect(rewrapWithSourceTags(["- No.", "- <i>Never.</i>"], ["- Nein.", "- Niemals."])).toEqual([
      "- Nein.",
      "- <i>Niemals.</i>",
    ]);
  });

  it("refuses when the source has a tag in the middle of a line", () => {
    expect(rewrapWithSourceTags(["A <i>bold</i> claim"], ["Eine Behauptung"])).toBeNull();
  });

  it("refuses when the line counts differ", () => {
    expect(rewrapWithSourceTags(["<i>a</i>"], ["a", "b"])).toBeNull();
  });
});
