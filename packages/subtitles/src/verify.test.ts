import { describe, expect, it } from "vitest";
import { FidelityError } from "./errors.js";
import { parseSubtitleText } from "./parse.js";
import { serialiseSubtitleDocument } from "./serialise.js";
import { assertStructuralFidelity, serialiseAndVerify } from "./verify.js";
import type { SubtitleDocument } from "./types.js";

const SOURCE = [
  "1",
  "00:00:01,000 --> 00:00:03,240",
  "The lighthouse has been dark for a week.",
  "",
  "2",
  "00:00:03,400 --> 00:00:06,120",
  "- And nobody thought to call?",
  "- <i>We called.</i>",
  "",
  "",
].join("\n");

function translated(doc: SubtitleDocument, lines: string[][]): SubtitleDocument {
  return {
    ...doc,
    cues: doc.cues.map((cue, index) => ({ ...cue, lines: lines[index] ?? cue.lines })),
  };
}

describe("assertStructuralFidelity", () => {
  const source = parseSubtitleText(SOURCE);

  it("passes when only the text changed", () => {
    const out = translated(source, [
      ["Der Leuchtturm ist seit einer Woche dunkel."],
      ["- Und niemand kam auf die Idee anzurufen?", "- <i>Wir haben angerufen.</i>"],
    ]);
    expect(() => {
      assertStructuralFidelity(source, parseSubtitleText(serialiseSubtitleDocument(out)));
    }).not.toThrow();
  });

  it("fails when a cue disappears", () => {
    const out = { ...source, cues: source.cues.slice(0, 1) };
    expect(() => {
      assertStructuralFidelity(source, out);
    }).toThrow(FidelityError);
  });

  it("fails when a timing line changed by a single character", () => {
    const cues = source.cues.map((cue, index) =>
      index === 1 ? { ...cue, rawTimingLine: "00:00:03,401 --> 00:00:06,120" } : cue,
    );
    expect(() => {
      assertStructuralFidelity(source, { ...source, cues });
    }).toThrow(/timing line of cue 2 changed/);
  });

  it("fails when an index line changed", () => {
    const cues = source.cues.map((cue, index) =>
      index === 0 ? { ...cue, rawIndexLine: "01" } : cue,
    );
    expect(() => {
      assertStructuralFidelity(source, { ...source, cues });
    }).toThrow(/index line of cue 1 changed/);
  });

  it("fails when a protected control code was lost", () => {
    const cues = source.cues.map((cue, index) =>
      index === 0 ? { ...cue, linePrefixCodes: [String.raw`{\an8}`] } : cue,
    );
    expect(() => {
      assertStructuralFidelity(source, { ...source, cues });
    }).toThrow(/control codes of cue 1 changed/);
  });

  it("fails when the format or the header changed", () => {
    expect(() => {
      assertStructuralFidelity(source, { ...source, format: "microdvd" });
    }).toThrow(/format changed/);
    expect(() => {
      assertStructuralFidelity(source, { ...source, header: "[INFORMATION]" });
    }).toThrow(/header block changed/);
  });
});

describe("serialiseAndVerify", () => {
  const source = parseSubtitleText(SOURCE);

  it("returns the text to store when the output re-parses to the same structure", () => {
    const out = translated(source, [["Zeile eins."], ["- Zeile zwei?", "- <i>Ja.</i>"]]);
    const { text, reparsed } = serialiseAndVerify(source, out);
    expect(text).toContain("Zeile eins.");
    expect(reparsed.cues.map((cue) => cue.rawTimingLine)).toEqual(
      source.cues.map((cue) => cue.rawTimingLine),
    );
  });

  it("throws when a translation smuggled a blank line into a cue", () => {
    // A blank line inside a cue splits the block, so the output would have three
    // cues where the input had two. This is exactly the class of damage the
    // final re-parse exists to catch.
    const out = translated(source, [["Zeile eins."], ["- Zeile zwei?", "", "- Ja."]]);
    expect(() => serialiseAndVerify(source, out)).toThrow(FidelityError);
  });

  it("throws when a MicroDVD translation smuggled a line separator into a cue", () => {
    const microdvd = parseSubtitleText(["{1}{1}25", "{24}{78}Line one.", ""].join("\n"));
    const out = translated(microdvd, [["Zeile eins.|Zeile zwei."]]);
    expect(() => serialiseAndVerify(microdvd, out)).toThrow(FidelityError);
  });

  it("throws when a SubViewer translation smuggled a break marker into a cue", () => {
    const subviewer = parseSubtitleText(
      ["00:00:01.00,00:00:03.24", "Line one.", "", ""].join("\n"),
    );
    const out = translated(subviewer, [["Zeile eins.[br]Zeile zwei."]]);
    expect(() => serialiseAndVerify(subviewer, out)).toThrow(FidelityError);
  });
});
