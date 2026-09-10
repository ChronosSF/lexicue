import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cueDialogueChars, cuePlainText, documentDialogueChars } from "./chars.js";
import { parseSubtitleBytes } from "./encoding/io.js";
import { parseSubtitleText } from "./parse.js";

const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

function readDoc(name: string): ReturnType<typeof parseSubtitleBytes> {
  return parseSubtitleBytes(new Uint8Array(readFileSync(FIXTURES + name)), { fileName: name });
}

describe("the character count invariant across formats", () => {
  it("counts the same dialogue identically in SubRip, MicroDVD and SubViewer", () => {
    const srt = readDoc("same-dialogue.srt");
    const microdvd = readDoc("same-dialogue.microdvd.sub");
    const subviewer = readDoc("same-dialogue.subviewer.sub");

    expect(srt.dialogueChars).toBe(microdvd.dialogueChars);
    expect(srt.dialogueChars).toBe(subviewer.dialogueChars);
    expect(srt.dialogueChars).toBe(129);
  });

  it("counts the same dialogue identically however the file is tagged", () => {
    // The three fixtures carry different tags and control codes on purpose:
    // SubRip has {\an8} and <i>, MicroDVD has {Y:i} and {y:i}, SubViewer has <i>.
    const srt = readDoc("same-dialogue.srt");
    const plain = readDoc("srt-basic.srt");
    expect(srt.dialogueChars).toBe(plain.dialogueChars);
  });

  it("never counts inline tags", () => {
    const tagged = parseSubtitleText(
      "1\n00:00:01,000 --> 00:00:02,000\n<i><b>Hello.</b></i>\n\n",
    ).dialogueChars;
    const bare = parseSubtitleText("1\n00:00:01,000 --> 00:00:02,000\nHello.\n\n").dialogueChars;
    expect(tagged).toBe(bare);
    expect(bare).toBe(6);
  });

  it("never counts a font tag's attributes", () => {
    const doc = parseSubtitleText(
      '1\n00:00:01,000 --> 00:00:02,000\n<font color="#ff00ff" face="Arial">Hello.</font>\n\n',
    );
    expect(doc.dialogueChars).toBe(6);
  });

  it("never counts control codes, at the start of a line or inside it", () => {
    const leading = parseSubtitleText(
      "1\n00:00:01,000 --> 00:00:02,000\n" + String.raw`{\an8}` + "Hello.\n\n",
    );
    const inline = parseSubtitleText("1\n00:00:01,000 --> 00:00:02,000\nHel{y:i}lo.\n\n");
    expect(leading.dialogueChars).toBe(6);
    expect(inline.dialogueChars).toBe(6);
  });

  it("counts spaces and punctuation", () => {
    const doc = parseSubtitleText("1\n00:00:01,000 --> 00:00:02,000\nOh, hello there!\n\n");
    expect(doc.dialogueChars).toBe("Oh, hello there!".length);
  });

  it("drops line breaks rather than replacing them with a space", () => {
    const twoLines = parseSubtitleText("1\n00:00:01,000 --> 00:00:02,000\nabc\ndef\n\n");
    expect(twoLines.dialogueChars).toBe(6);
  });

  it("counts an astral character once, not twice", () => {
    const doc = parseSubtitleText("1\n00:00:01,000 --> 00:00:02,000\na\u{1F600}b\n\n");
    expect(doc.dialogueChars).toBe(3);
  });

  it("counts nothing for a cue with no text", () => {
    expect(cueDialogueChars({ lines: [] })).toBe(0);
    expect(documentDialogueChars([])).toBe(0);
  });
});

describe("the count charged equals the count previewed", () => {
  it("is a pure function of the parsed cues", () => {
    for (const name of [
      "srt-basic.srt",
      "srt-hearing-impaired.srt",
      "microdvd-control-codes.sub",
      "subviewer-basic.sub",
      "srt-windows-1251.srt",
    ]) {
      const doc = readDoc(name);
      expect(doc.dialogueChars).toBe(documentDialogueChars(doc.cues));
      // Parsing the same bytes again must give the same number, whoever does it.
      expect(readDoc(name).dialogueChars).toBe(doc.dialogueChars);
    }
  });

  it("does not change when the encoding does", () => {
    const cyrillic = readDoc("srt-windows-1251.srt");
    const asUtf8 = parseSubtitleText(
      [
        "1",
        "00:00:01,000 --> 00:00:03,240",
        "Фарът е тъмен от една седмица.",
        "",
        "2",
        "00:00:03,400 --> 00:00:06,120",
        "- И никой ли не се обади?",
        "- Обадихме се. Никой не отговори.",
        "",
        "",
      ].join("\n"),
    );
    expect(asUtf8.dialogueChars).toBe(cyrillic.dialogueChars);
  });
});

describe("cuePlainText", () => {
  it("gives the spoken text with markup removed, for the advisory metrics", () => {
    const doc = parseSubtitleText(
      "1\n00:00:01,000 --> 00:00:02,000\n- <i>Never.</i>\n- Truly.\n\n",
    );
    expect(cuePlainText(doc.cues[0] ?? { lines: [] })).toBe("- Never. - Truly.");
  });
});
