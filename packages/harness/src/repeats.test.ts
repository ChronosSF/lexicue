import { describe, expect, it } from "vitest";
import { REPEAT_LIMIT, findRepeatedLines, findRepeatedLinesAcross, repeatKey } from "./repeats.js";
import type { ProtocolCue } from "./types.js";

function cues(...texts: string[]): ProtocolCue[] {
  return texts.map((text, index) => ({ id: index + 1, lines: text.split("|") }));
}

describe("finding the lines a source repeats", () => {
  it("groups a line that comes back, with its count and its cue ids", () => {
    const found = findRepeatedLines(
      cues(
        "The line doesn't care.",
        "Twelve weeks already.",
        "The line doesn't care.",
        "Nothing to report here.",
        "The line doesn't care.",
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe("The line doesn't care.");
    expect(found[0]?.occurrences).toBe(3);
    expect(found[0]?.ids).toEqual([1, 3, 5]);
  });

  it("joins a two-line cue before comparing it", () => {
    const found = findRepeatedLines(
      cues("Count it twice,|say it once.", "Count it twice, say it once."),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.occurrences).toBe(2);
  });

  it("sees through markup, whitespace and the typographic variants", () => {
    expect(repeatKey("<i>The line doesn't care.</i>")).toBe(repeatKey("The line doesn’t care"));
    expect(repeatKey("{\\an8}Say it   once…")).toBe(repeatKey("Say it once..."));
    expect(repeatKey('"Write it in the log."')).toBe(repeatKey("Write it in the log"));
    expect(repeatKey("Say it once -")).toBe(repeatKey("Say it once"));
  });

  /**
   * The fault this exists for was reported by the judge as one drifting
   * catchphrase, but the season's source says "Write that in the log." in
   * episode one and "Write it in the log." in episode two. They are different
   * sentences, a faithful translation renders them differently, and fixing one
   * rendering for both would make the translation worse. Only a verbatim repeat
   * gets a fixed rendering.
   */
  it("keeps two lines apart when they differ by a word", () => {
    expect(findRepeatedLines(cues("Write that in the log.", "Write it in the log."))).toEqual([]);
  });

  it("ignores lines too short to be worth fixing", () => {
    expect(findRepeatedLines(cues("Yes.", "Yes.", "No, sir.", "No, sir."))).toEqual([]);
  });

  it("ignores a line that occurs only once", () => {
    expect(findRepeatedLines(cues("The line doesn't care.", "Something else here."))).toEqual([]);
  });

  it("ranks the most frequent first and is stable across two calls", () => {
    const sample = cues(
      "The line doesn't care.",
      "Count it twice, say it once.",
      "The line doesn't care.",
      "Count it twice, say it once.",
      "The line doesn't care.",
    );
    const first = findRepeatedLines(sample);
    expect(first.map((line) => line.occurrences)).toEqual([3, 2]);
    expect(findRepeatedLines(sample)).toEqual(first);
  });

  it("caps the list so a glossary request stays bounded", () => {
    const many: ProtocolCue[] = [];
    for (let group = 0; group < REPEAT_LIMIT + 5; group += 1) {
      for (const copy of [0, 1]) {
        many.push({
          id: group * 2 + copy + 1,
          lines: [`Repeated sentence number ${group.toString()} here.`],
        });
      }
    }
    expect(findRepeatedLines(many)).toHaveLength(REPEAT_LIMIT);
  });

  it("respects floors a caller lowers", () => {
    expect(
      findRepeatedLines(cues("Yes, sir.", "Yes, sir."), { minChars: 4, minWords: 2 }),
    ).toHaveLength(1);
  });
});

describe("finding the lines an upload repeats across its files", () => {
  /**
   * A catchphrase said once an episode never repeats inside any one file, so
   * the file's own pass cannot see it. The season pass is the only one that can.
   */
  it("counts occurrences across files that never repeat internally", () => {
    const found = findRepeatedLinesAcross([
      cues("The light has opinions.", "Twelve weeks already."),
      cues("Sixteen weeks already.", "The light has opinions."),
      cues("The light has opinions.", "Nothing to report here."),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe("The light has opinions.");
    expect(found[0]?.occurrences).toBe(3);
    // Ids from different files would collide, so the upload-wide group has none.
    expect(found[0]?.ids).toEqual([]);
  });

  it("finds nothing when no file shares a line with another", () => {
    expect(
      findRepeatedLinesAcross([cues("Write that in the log."), cues("Write it in the log.")]),
    ).toEqual([]);
  });
});
