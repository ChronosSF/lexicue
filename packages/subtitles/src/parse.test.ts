import { describe, expect, it } from "vitest";
import { parseSubtitleText } from "./parse.js";
import { serialiseSubtitleDocument } from "./serialise.js";
import { detectFormat } from "./detect.js";

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "Hello there.",
  "",
  "1417",
  "01:52:07,210 --> 01:52:09,940 X1:100 X2:620 Y1:420 Y2:480",
  "{\\an8}- Don't tell me you forgot.",
  "- <i>Never.</i>",
  "",
].join("\n");

const MICRODVD = [
  "{1}{1}23.976",
  "{24}{72}Hello there.",
  "{2688}{2753}- Don't tell me you forgot.|- {y:i}Never.",
  "",
].join("\n");

const SUBVIEWER = [
  "[INFORMATION]",
  "[TITLE]Test",
  "[END INFORMATION]",
  "",
  "00:00:01.00,00:00:03.00",
  "Hello there.",
  "",
  "01:52:07.21,01:52:09.94",
  "- Don't tell me you forgot.[br]- Never.",
  "",
].join("\n");

describe("format detection", () => {
  it("recognises each supported format from its content", () => {
    expect(detectFormat(SRT, "a.srt")).toBe("srt");
    expect(detectFormat(MICRODVD, "a.sub")).toBe("microdvd");
    expect(detectFormat(SUBVIEWER, "a.sub")).toBe("subviewer");
  });
});

describe("round trip", () => {
  it.each([
    ["srt", SRT],
    ["microdvd", MICRODVD],
    ["subviewer", SUBVIEWER],
  ])("serialise(parse(%s)) is byte identical", (_format, text) => {
    expect(serialiseSubtitleDocument(parseSubtitleText(text))).toBe(text);
  });

  it.each([
    ["srt", SRT],
    ["microdvd", MICRODVD],
    ["subviewer", SUBVIEWER],
  ])("round trips %s with CRLF endings", (_format, text) => {
    const crlf = text.split("\n").join("\r\n");
    const doc = parseSubtitleText(crlf);
    expect(doc.eol).toBe("\r\n");
    expect(serialiseSubtitleDocument(doc)).toBe(crlf);
  });
});

describe("the parsed model", () => {
  it("keeps the index line, the timing line and the position hints verbatim", () => {
    const doc = parseSubtitleText(SRT);
    expect(doc.cues).toHaveLength(2);
    expect(doc.cues[1]?.rawIndexLine).toBe("1417");
    expect(doc.cues[1]?.rawTimingLine).toBe(
      "01:52:07,210 --> 01:52:09,940 X1:100 X2:620 Y1:420 Y2:480",
    );
    expect(doc.cues[1]?.startMs).toBe(6_727_210);
    expect(doc.cues[1]?.endMs).toBe(6_729_940);
  });

  it("strips positioning overrides and MicroDVD control codes out of the text", () => {
    const srt = parseSubtitleText(SRT);
    expect(srt.cues[1]?.prefixCodes).toBe("{\\an8}");
    expect(srt.cues[1]?.lines).toEqual(["- Don't tell me you forgot.", "- <i>Never.</i>"]);

    const sub = parseSubtitleText(MICRODVD);
    expect(sub.cues[1]?.linePrefixCodes).toEqual(["", ""]);
    expect(sub.cues[1]?.lines).toEqual(["- Don't tell me you forgot.", "- {y:i}Never."]);
  });

  it("keeps the MicroDVD frame-rate line as the header and reads the frame rate", () => {
    const doc = parseSubtitleText(MICRODVD);
    expect(doc.header).toBe("{1}{1}23.976");
    expect(doc.frameRate).toBeCloseTo(23.976, 3);
    expect(doc.cues).toHaveLength(2);
  });

  it("keeps the SubViewer information block as the header", () => {
    const doc = parseSubtitleText(SUBVIEWER);
    expect(doc.header).toBe("[INFORMATION]\n[TITLE]Test\n[END INFORMATION]");
    expect(doc.cues[1]?.lines).toEqual(["- Don't tell me you forgot.", "- Never."]);
  });
});

describe("dialogueChars", () => {
  it("is identical for the same dialogue in all three formats", () => {
    const srt = parseSubtitleText(SRT).dialogueChars;
    const microdvd = parseSubtitleText(MICRODVD).dialogueChars;
    const subviewer = parseSubtitleText(SUBVIEWER).dialogueChars;
    expect(srt).toBe(microdvd);
    expect(srt).toBe(subviewer);
    expect(srt).toBe("Hello there.".length + "- Don't tell me you forgot.- Never.".length);
  });
});
