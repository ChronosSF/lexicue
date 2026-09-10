import { describe, expect, it } from "vitest";
import { detectFormat, inspectBytes } from "./detect.js";
import { isMicroDvdFrameRateLine, isMicroDvdLine } from "./formats/microdvd.js";
import { isSrtTimingLine, parseSrtTiming } from "./formats/srt.js";
import { isSubViewerTimingLine, parseSubViewerTiming } from "./formats/subviewer.js";
import { parseSubtitleText } from "./parse.js";
import { serialiseSubtitleDocument } from "./serialise.js";
import { countTrailingBlanks, detectLineEnding, encodeUtf8, splitLines, stripBom } from "./text.js";

/**
 * Spec section 3.1: "Tolerate the mess real files contain ... None of these are
 * the user's problem to fix." These are the messes that produce a warning
 * rather than a rejection.
 */
describe("messy SubRip files", () => {
  it("ignores a block with no timing line and says so", () => {
    const doc = parseSubtitleText(
      [
        "This file was edited by hand",
        "and this note ended up in it.",
        "",
        "1",
        "00:00:01,000 --> 00:00:03,000",
        "The actual first cue.",
        "",
        "",
      ].join("\n"),
    );
    expect(doc.cues).toHaveLength(1);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/Ignored 2 line\(s\) at line 1/);
  });

  it("ignores stray lines before the timing line and keeps the one just above it", () => {
    const doc = parseSubtitleText(
      ["junk", "42", "00:00:01,000 --> 00:00:03,000", "Text.", "", ""].join("\n"),
    );
    expect(doc.cues[0]?.rawIndexLine).toBe("42");
    expect(doc.warnings[0]).toMatch(/Ignored 1 stray line\(s\)/);
  });

  it("accepts extra blank lines between cues", () => {
    const doc = parseSubtitleText(
      [
        "1",
        "00:00:01,000 --> 00:00:03,000",
        "One.",
        "",
        "",
        "",
        "2",
        "00:00:04,000 --> 00:00:05,000",
        "Two.",
        "",
        "",
      ].join("\n"),
    );
    expect(doc.cues).toHaveLength(2);
  });

  it("accepts a single-arrow timing line and leading whitespace", () => {
    const doc = parseSubtitleText(
      ["1", "  00:00:01,000 -> 00:00:03,000", "Text.", "", ""].join("\n"),
    );
    expect(doc.cues[0]?.rawTimingLine).toBe("  00:00:01,000 -> 00:00:03,000");
    expect(doc.cues[0]?.startMs).toBe(1000);
  });

  it("accepts one- and two-digit milliseconds", () => {
    const doc = parseSubtitleText(["00:00:01,5 --> 00:00:03,25", "Text.", "", ""].join("\n"));
    expect(doc.cues[0]?.startMs).toBe(1500);
    expect(doc.cues[0]?.endMs).toBe(3250);
  });

  it("accepts a cue with an index and a timing line but no text", () => {
    const text = ["1", "00:00:01,000 --> 00:00:03,000", "", "", ""].join("\n");
    const doc = parseSubtitleText(text);
    expect(doc.cues[0]?.lines).toEqual([]);
    expect(doc.dialogueChars).toBe(0);
  });
});

describe("messy MicroDVD files", () => {
  it("ignores a line that is not a cue and says so", () => {
    const doc = parseSubtitleText(
      ["{1}{1}25", "a stray comment line", "{24}{78}Real cue.", ""].join("\n"),
      { format: "microdvd" },
    );
    expect(doc.cues).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/Ignored line 2/);
  });

  it("ignores a blank line in the middle of the file and says so", () => {
    const doc = parseSubtitleText(["{24}{78}One.", "", "{82}{147}Two.", ""].join("\n"), {
      format: "microdvd",
    });
    expect(doc.cues).toHaveLength(2);
    expect(doc.warnings[0]).toMatch(/Ignored a blank line at line 2/);
  });

  it("uses the caller's default frame rate when the file has no frame-rate line", () => {
    const doc = parseSubtitleText(["{25}{50}One.", ""].join("\n"), {
      format: "microdvd",
      defaultFrameRate: 25,
    });
    expect(doc.frameRate).toBe(25);
    expect(doc.cues[0]?.startMs).toBe(1000);
  });

  it("keeps the default frame rate when the file declares zero", () => {
    const doc = parseSubtitleText(["{0}{0}0", "{25}{50}One.", ""].join("\n"), {
      format: "microdvd",
    });
    expect(doc.cues[0]?.startMs).toBe(1043);
  });

  it("reads a comma-decimal frame rate", () => {
    const doc = parseSubtitleText(["{1}{1}23,976", "{24}{78}One.", ""].join("\n"), {
      format: "microdvd",
    });
    expect(doc.frameRate).toBeCloseTo(23.976, 3);
  });

  it("recognises frame-rate lines", () => {
    expect(isMicroDvdFrameRateLine("{1}{1}23.976")).toBe(true);
    expect(isMicroDvdFrameRateLine("{1}{1}Hello")).toBe(false);
    expect(isMicroDvdFrameRateLine("not a cue")).toBe(false);
    expect(isMicroDvdLine("{24}{78}Text")).toBe(true);
  });
});

describe("messy SubViewer files", () => {
  it("ignores a block whose first line is not a timing line and says so", () => {
    const doc = parseSubtitleText(
      [
        "00:00:01.00,00:00:03.00",
        "One.",
        "",
        "a stray block",
        "with two lines",
        "",
        "00:00:04.00,00:00:05.00",
        "Two.",
        "",
        "",
      ].join("\n"),
    );
    expect(doc.format).toBe("subviewer");
    expect(doc.cues).toHaveLength(2);
    expect(doc.warnings[0]).toMatch(/Ignored 2 line\(s\)/);
  });

  it("serialises a cue with no text as the timing line alone", () => {
    const doc = parseSubtitleText(["00:00:01.00,00:00:03.00", "One.", "", ""].join("\n"));
    const emptied = {
      ...doc,
      cues: doc.cues.map((cue) => ({ ...cue, lines: [], linePrefixCodes: [] })),
    };
    expect(serialiseSubtitleDocument(emptied)).toBe("00:00:01.00,00:00:03.00\n\n");
  });
});

describe("timing helpers", () => {
  it("report no timing for a line that is not one", () => {
    expect(parseSrtTiming("not a timing line")).toBeNull();
    expect(parseSubViewerTiming("not a timing line")).toBeNull();
    expect(isSrtTimingLine("00:00:01,000 --> 00:00:03,000")).toBe(true);
    expect(isSubViewerTimingLine("00:00:01.00,00:00:03.00")).toBe(true);
  });
});

describe("format detection edge cases", () => {
  it("returns null for prose with no timings at all", () => {
    expect(detectFormat("Just some notes.\nNothing timed here.")).toBeNull();
  });

  it("recognises a SubViewer file from its information block alone", () => {
    expect(detectFormat("[INFORMATION]\n[TITLE]Nothing else\n")).toBe("subviewer");
  });

  it("falls back to the .srt extension when the arrow is there but the timings are odd", () => {
    expect(detectFormat("0:1 --> 0:2\nText\n", "odd.srt")).toBe("srt");
    expect(detectFormat("0:1 --> 0:2\nText\n", "odd.sub")).toBeNull();
    expect(detectFormat("0:1 --> 0:2\nText\n")).toBeNull();
  });

  it("prefers the format with the most timing lines", () => {
    const mixed = ["{24}{78}One.", "00:00:01,000 --> 00:00:02,000", "Two."].join("\n");
    expect(detectFormat(mixed)).toBe("srt");
  });

  it("reports an empty file before anything else", () => {
    expect(inspectBytes(new Uint8Array(0), "a.srt")).toBe("empty");
  });
});

describe("text helpers", () => {
  it("counts trailing blank lines", () => {
    expect(countTrailingBlanks(splitLines("a\n\n"))).toBe(2);
    expect(countTrailingBlanks(splitLines("a"))).toBe(0);
  });

  it("prefers CRLF only when it is at least as common as LF", () => {
    expect(detectLineEnding("a\r\nb\r\nc\nd")).toBe("\r\n");
    expect(detectLineEnding("a\r\nb\nc\nd")).toBe("\n");
    expect(detectLineEnding("a\nb")).toBe("\n");
  });

  it("splits on a lone carriage return too", () => {
    expect(splitLines("a\rb")).toEqual(["a", "b"]);
  });

  it("reports whether a byte-order mark was stripped", () => {
    expect(stripBom("plain")).toEqual({ text: "plain", bom: false });
    expect(stripBom(String.fromCodePoint(0xfeff) + "marked")).toEqual({
      text: "marked",
      bom: true,
    });
  });

  it("encodes without a mark by default", () => {
    expect(Array.from(encodeUtf8("A"))).toEqual([0x41]);
    expect(Array.from(encodeUtf8("A", { bom: true }))).toEqual([0xef, 0xbb, 0xbf, 0x41]);
  });
});
