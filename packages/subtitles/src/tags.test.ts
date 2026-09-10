import { describe, expect, it } from "vitest";
import {
  describeMarkup,
  listControlCodes,
  listMarkup,
  listTags,
  markupMultiset,
  markupMultisetsEqual,
  normaliseTag,
  splitLeadingCodes,
  stripMarkup,
  tagMultiset,
  tagMultisetsEqual,
} from "./tags.js";

describe("splitLeadingCodes", () => {
  it("takes the positioning override off the front of a line", () => {
    expect(splitLeadingCodes(String.raw`{\an8}TWELVE YEARS EARLIER`)).toEqual({
      codes: String.raw`{\an8}`,
      rest: "TWELVE YEARS EARLIER",
    });
  });

  it("takes several codes at once", () => {
    expect(splitLeadingCodes("{y:i}{c:$0000ff}Blue italics")).toEqual({
      codes: "{y:i}{c:$0000ff}",
      rest: "Blue italics",
    });
  });

  it("leaves a line with no leading code alone", () => {
    expect(splitLeadingCodes("- Never.")).toEqual({ codes: "", rest: "- Never." });
  });

  it("leaves a code that is not at the start of the line in the text", () => {
    expect(splitLeadingCodes("- {y:i}Never.")).toEqual({ codes: "", rest: "- {y:i}Never." });
  });

  it("does not mistake ordinary braces in dialogue for a code", () => {
    expect(splitLeadingCodes("{ hello }")).toEqual({ codes: "", rest: "{ hello }" });
  });
});

describe("stripMarkup", () => {
  it("removes inline tags and control codes and nothing else", () => {
    expect(stripMarkup('<i>Hello</i>, <font color="#fff">world</font>{y:i}!')).toBe(
      "Hello, world!",
    );
  });

  it("leaves an unrelated angle bracket alone", () => {
    expect(stripMarkup("2 < 3 and 4 > 3")).toBe("2 < 3 and 4 > 3");
  });
});

describe("normaliseTag", () => {
  it("lower-cases the tag name and keeps the attributes", () => {
    expect(normaliseTag('<FONT COLOR="#FF0000">')).toBe('<font COLOR="#FF0000">');
    expect(normaliseTag("</ I >")).toBe("</i>");
  });
});

describe("multisets", () => {
  it("treats the same tags in a different order as equal", () => {
    expect(tagMultisetsEqual("<i>a</i> <b>b</b>", "<b>b</b> <i>a</i>")).toBe(true);
  });

  it("treats a dropped closing tag as different", () => {
    expect(tagMultisetsEqual("<i>a</i>", "<i>a")).toBe(false);
  });

  it("treats a changed font colour as different", () => {
    expect(
      tagMultisetsEqual('<font color="#ff0000">a</font>', '<font color="#00ff00">a</font>'),
    ).toBe(false);
  });

  it("counts repeated tags", () => {
    expect(tagMultiset("<i>a</i><i>b</i>")).toEqual(
      new Map([
        ["<i>", 2],
        ["</i>", 2],
      ]),
    );
  });

  it("includes control codes in the markup multiset but not the tag multiset", () => {
    expect(tagMultiset("- {y:i}a").size).toBe(0);
    expect(markupMultiset("- {y:i}a")).toEqual(new Map([["{y:i}", 1]]));
    expect(markupMultisetsEqual("- {y:i}Never.", "- Niemals.")).toBe(false);
    expect(markupMultisetsEqual("- {y:i}Never.", "- {y:i}Niemals.")).toBe(true);
  });

  it("lists tags and codes in the order they appear", () => {
    expect(listTags("<i>a</i><b>b</b>")).toEqual(["<i>", "</i>", "<b>", "</b>"]);
    expect(listControlCodes("{y:i}a{c:$00ff00}")).toEqual(["{y:i}", "{c:$00ff00}"]);
    expect(listMarkup("<i>{y:i}a</i>")).toEqual(["<i>", "{y:i}", "</i>"]);
  });

  it("describes markup for a validator finding", () => {
    expect(describeMarkup("<i>a</i>")).toBe("<i> </i>");
    expect(describeMarkup("plain")).toBe("no tags");
  });
});
