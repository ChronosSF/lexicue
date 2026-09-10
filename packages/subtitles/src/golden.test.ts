import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSubtitleBytes } from "./encoding/io.js";
import { serialiseSubtitleDocument } from "./serialise.js";
import { encodeUtf8 } from "./text.js";
import type { SubtitleFormat } from "./types.js";

const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

function read(name: string): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURES + name));
}

interface Expectation {
  format: SubtitleFormat;
  encoding: string;
  bom: boolean;
  eol: "lf" | "crlf";
  cues: number;
  /** The billable characters of spec section 6.1, pinned per fixture. */
  dialogueChars: number;
  trailingNewline: boolean;
  header?: string;
  /** False only where the parse is deliberately lossy; see the tests below. */
  byteIdenticalRoundTrip?: boolean;
}

/**
 * The corpus of real-world shapes spec section 10.1 asks for. Every entry names
 * the shape it exists to cover.
 */
const GOLDEN: Record<string, Expectation> = {
  // A clean file, the baseline every other count is compared against.
  "srt-basic.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 3,
    dialogueChars: 129,
    trailingNewline: true,
  },
  // Missing indices: blocks that start straight at the timing line.
  "srt-missing-indices.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 2,
    dialogueChars: 75,
    trailingNewline: true,
  },
  // Non-sequential and repeated indices, copied through untouched.
  "srt-nonsequential.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 3,
    dialogueChars: 60,
    trailingNewline: true,
  },
  // A period instead of a comma before the milliseconds.
  "srt-period-milliseconds.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 2,
    dialogueChars: 60,
    trailingNewline: true,
  },
  // Position hints after the arrow, which stay part of the raw timing line.
  "srt-position-hints.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 2,
    dialogueChars: 59,
    trailingNewline: true,
  },
  // Nested and attributed inline tags.
  "srt-nested-tags.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 3,
    dialogueChars: 61,
    trailingNewline: true,
  },
  // Positioning overrides, stripped into prefixCodes.
  "srt-positioning-codes.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 2,
    dialogueChars: 37,
    trailingNewline: true,
  },
  // Overlapping cues, which are legal input and must not be reordered.
  "srt-overlapping.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 2,
    dialogueChars: 29,
    trailingNewline: true,
  },
  // CRLF endings, preserved.
  "srt-crlf.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "crlf",
    cues: 1,
    dialogueChars: 24,
    trailingNewline: true,
  },
  // A byte-order mark, preserved.
  "srt-bom.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: true,
    eol: "lf",
    cues: 1,
    dialogueChars: 34,
    trailingNewline: true,
  },
  // Mixed line endings; the dominant ending wins and the file is normalised.
  "srt-mixed-eol.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "crlf",
    cues: 2,
    dialogueChars: 62,
    trailingNewline: true,
    byteIdenticalRoundTrip: false,
  },
  // Windows-1251 input; the text round trips, the bytes come back as UTF-8.
  "srt-windows-1251.srt": {
    format: "srt",
    encoding: "windows-1251",
    bom: false,
    eol: "lf",
    cues: 2,
    dialogueChars: 88,
    trailingNewline: true,
    byteIdenticalRoundTrip: false,
  },
  // A hearing-impaired edition: bracketed sounds, speaker labels, music notes.
  "srt-hearing-impaired.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 3,
    dialogueChars: 93,
    trailingNewline: true,
  },
  // HTML entities and trailing whitespace, both left exactly as they were.
  "srt-entities-and-whitespace.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 2,
    dialogueChars: 69,
    trailingNewline: true,
  },
  // A file that ends with a single newline instead of the usual blank line.
  "srt-single-trailing-newline.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 1,
    dialogueChars: 25,
    trailingNewline: false,
  },
  // MicroDVD with its frame-rate line.
  "microdvd-basic.sub": {
    format: "microdvd",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 3,
    dialogueChars: 129,
    trailingNewline: true,
    header: "{1}{1}23.976",
  },
  // MicroDVD without one; the parser assumes the default frame rate.
  "microdvd-no-frame-rate.sub": {
    format: "microdvd",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 2,
    dialogueChars: 63,
    trailingNewline: true,
    header: "",
  },
  // MicroDVD control codes, at the start of a cue and after a speaker dash.
  "microdvd-control-codes.sub": {
    format: "microdvd",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 3,
    dialogueChars: 90,
    trailingNewline: true,
    header: "{1}{1}25",
  },
  // A SubViewer information block.
  "subviewer-basic.sub": {
    format: "subviewer",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 3,
    dialogueChars: 129,
    trailingNewline: true,
  },
  // SubViewer without one.
  "subviewer-no-header.sub": {
    format: "subviewer",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 2,
    dialogueChars: 59,
    trailingNewline: true,
    header: "",
  },
  // The same dialogue in all three formats; see chars.test.ts for the invariant.
  "same-dialogue.srt": {
    format: "srt",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 3,
    dialogueChars: 129,
    trailingNewline: true,
  },
  "same-dialogue.microdvd.sub": {
    format: "microdvd",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 3,
    dialogueChars: 129,
    trailingNewline: true,
  },
  "same-dialogue.subviewer.sub": {
    format: "subviewer",
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    cues: 3,
    dialogueChars: 129,
    trailingNewline: true,
  },
};

describe.each(Object.entries(GOLDEN))("golden fixture %s", (name, expected) => {
  const bytes = read(name);
  const doc = parseSubtitleBytes(bytes, { fileName: name });

  it("parses to the expected document", () => {
    expect({
      format: doc.format,
      encoding: doc.encoding,
      bom: doc.bom,
      eol: doc.eol === "\r\n" ? "crlf" : "lf",
      cues: doc.cues.length,
      dialogueChars: doc.dialogueChars,
      trailingNewline: doc.trailingNewline,
    }).toEqual({
      format: expected.format,
      encoding: expected.encoding,
      bom: expected.bom,
      eol: expected.eol,
      cues: expected.cues,
      dialogueChars: expected.dialogueChars,
      trailingNewline: expected.trailingNewline,
    });
    if (expected.header !== undefined) expect(doc.header).toBe(expected.header);
  });

  it("numbers cues from one and in file order", () => {
    expect(doc.cues.map((cue) => cue.id)).toEqual(
      Array.from({ length: expected.cues }, (_unused, index) => index + 1),
    );
    for (let i = 1; i < doc.cues.length; i += 1) {
      expect(doc.cues[i]?.startMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps one protected-code slot per line", () => {
    for (const cue of doc.cues) {
      expect(cue.linePrefixCodes).toHaveLength(cue.lines.length);
      expect(cue.prefixCodes).toBe(cue.linePrefixCodes[0] ?? "");
    }
  });

  it("parses without complaining about the file", () => {
    expect(doc.warnings).toEqual([]);
  });

  if (expected.byteIdenticalRoundTrip !== false) {
    it("serialises back to the original bytes", () => {
      const out = encodeUtf8(serialiseSubtitleDocument(doc), { bom: doc.bom });
      expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true);
    });
  }
});

describe("the two deliberately lossy fixtures", () => {
  it("normalises mixed line endings to the dominant one", () => {
    const doc = parseSubtitleBytes(read("srt-mixed-eol.srt"), { fileName: "srt-mixed-eol.srt" });
    const out = serialiseSubtitleDocument(doc);
    expect(doc.eol).toBe("\r\n");
    expect(out.includes("\n")).toBe(true);
    expect(
      out.split("\n").every((line, index, all) => index === all.length - 1 || line.endsWith("\r")),
    ).toBe(true);
    expect(doc.cues.map((cue) => cue.rawTimingLine)).toEqual([
      "00:00:01,000 --> 00:00:03,240",
      "00:00:03,400 --> 00:00:06,120",
    ]);
  });

  it("re-encodes a Windows-1251 file as UTF-8 with the same text", () => {
    const name = "srt-windows-1251.srt";
    const doc = parseSubtitleBytes(read(name), { fileName: name });
    expect(doc.cues[0]?.lines).toEqual(["Фарът е тъмен от една седмица."]);
    const out = encodeUtf8(serialiseSubtitleDocument(doc), { bom: false });
    expect(new TextDecoder("utf-8", { fatal: true }).decode(out)).toContain(
      "Обадихме се. Никой не отговори.",
    );
  });
});

describe("shapes worth naming individually", () => {
  it("copies non-sequential and repeated index lines through untouched", () => {
    const doc = parseSubtitleBytes(read("srt-nonsequential.srt"), { fileName: "x.srt" });
    expect(doc.cues.map((cue) => cue.rawIndexLine)).toEqual(["1", "5", "5"]);
  });

  it("leaves cues with no index line as null", () => {
    const doc = parseSubtitleBytes(read("srt-missing-indices.srt"), { fileName: "x.srt" });
    expect(doc.cues.map((cue) => cue.rawIndexLine)).toEqual([null, null]);
  });

  it("keeps position hints inside the raw timing line", () => {
    const doc = parseSubtitleBytes(read("srt-position-hints.srt"), { fileName: "x.srt" });
    expect(doc.cues[1]?.rawTimingLine).toBe(
      "01:52:07,210 --> 01:52:09,940 X1:100 X2:620 Y1:420 Y2:480",
    );
  });

  it("does not reorder overlapping cues", () => {
    const doc = parseSubtitleBytes(read("srt-overlapping.srt"), { fileName: "x.srt" });
    expect(doc.cues[0]?.endMs).toBeGreaterThan(doc.cues[1]?.startMs ?? 0);
    expect(doc.cues[0]?.lines[0]).toBe("I was still talking.");
  });

  it("reads the MicroDVD frame rate from the header line", () => {
    const doc = parseSubtitleBytes(read("microdvd-basic.sub"), { fileName: "x.sub" });
    expect(doc.frameRate).toBeCloseTo(23.976, 3);
    expect(doc.cues[0]?.startMs).toBe(1001);
  });

  it("keeps the whole SubViewer information block as the header", () => {
    const doc = parseSubtitleBytes(read("subviewer-basic.sub"), { fileName: "x.sub" });
    expect(doc.header.split("\n")[0]).toBe("[INFORMATION]");
    expect(doc.header).toContain("[COLF]&HFFFFFF,[STYLE]no,[SIZE]12,[FONT]Arial");
  });

  it("splits SubViewer line breaks into separate lines", () => {
    const doc = parseSubtitleBytes(read("subviewer-basic.sub"), { fileName: "x.sub" });
    expect(doc.cues[1]?.lines).toEqual([
      "- And nobody thought to call?",
      "- We called. Nobody answered.",
    ]);
  });

  it("keeps trailing whitespace and HTML entities in the cue text", () => {
    const doc = parseSubtitleBytes(read("srt-entities-and-whitespace.srt"), { fileName: "x.srt" });
    expect(doc.cues[0]?.lines[0]).toBe("Salt &amp; rope, that's all we need.   ");
  });
});
