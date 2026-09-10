import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { documentDialogueChars } from "./chars.js";
import { parseSubtitleText } from "./parse.js";
import { serialiseSubtitleDocument } from "./serialise.js";
import type { SubtitleFormat } from "./types.js";

/**
 * The round-trip property of spec section 10.1: for every well-formed generated
 * file, `serialise(parse(file))` equals the file byte for byte.
 *
 * The generators below produce the two file endings the serialiser is defined
 * for (a closing blank line, or a single newline), both line endings, indices
 * present or absent, inline tags, and positioning or control codes.
 */

const SAFE_CHARS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.!?'—&%()àéößšč шкаαβ",
);

const BARE_TEXT = fc
  .array(fc.constantFrom(...SAFE_CHARS), { minLength: 1, maxLength: 44 })
  .map((chars) => chars.join(""))
  .filter((text) => text.trim() !== "")
  // A MicroDVD cue whose whole text is a bare number is that format's
  // frame-rate line, so it is not a well-formed cue and is excluded here.
  .filter((text) => !/^\d{1,3}(?:[.,]\d+)?$/.test(text));

const TAGGED_TEXT = fc.oneof(
  { arbitrary: BARE_TEXT, weight: 6 },
  { arbitrary: BARE_TEXT.map((text) => `<i>${text}</i>`), weight: 2 },
  { arbitrary: BARE_TEXT.map((text) => `<b>${text}</b>`), weight: 1 },
  {
    arbitrary: BARE_TEXT.map((text) => `<font color="#ffff00">${text}</font>`),
    weight: 1,
  },
);

const PREFIX_CODE = fc.constantFrom("", "", "", String.raw`{\an8}`, "{y:i}", "{c:$0000ff}");

const TIME = fc
  .tuple(
    fc.integer({ min: 0, max: 2 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 999 }),
  )
  .map(([h, m, s, ms]) => ({ h, m, s, ms }));

const pad = (value: number, width: number): string => value.toString().padStart(width, "0");

interface GeneratedCue {
  index: string | null;
  start: { h: number; m: number; s: number; ms: number };
  end: { h: number; m: number; s: number; ms: number };
  prefix: string;
  lines: string[];
}

const GENERATED_CUE = fc.record({
  index: fc.option(fc.integer({ min: 1, max: 9999 }).map(String), { nil: null }),
  start: TIME,
  end: TIME,
  prefix: PREFIX_CODE,
  lines: fc.array(TAGGED_TEXT, { minLength: 1, maxLength: 3 }),
});

const DOCUMENT = fc.record({
  cues: fc.array(GENERATED_CUE, { minLength: 1, maxLength: 8 }),
  eol: fc.constantFrom("\n", "\r\n"),
  trailingNewline: fc.boolean(),
  withHeader: fc.boolean(),
});

interface GeneratedDocument {
  cues: GeneratedCue[];
  eol: string;
  trailingNewline: boolean;
  withHeader: boolean;
}

function renderCueText(cue: GeneratedCue, separator: string): string {
  const [first = "", ...rest] = cue.lines;
  return [cue.prefix + first, ...rest].join(separator);
}

function renderSrt(doc: GeneratedDocument): string {
  const blocks = doc.cues.map((cue) => {
    const timing = `${pad(cue.start.h, 2)}:${pad(cue.start.m, 2)}:${pad(cue.start.s, 2)},${pad(cue.start.ms, 3)} --> ${pad(cue.end.h, 2)}:${pad(cue.end.m, 2)}:${pad(cue.end.s, 2)},${pad(cue.end.ms, 3)}`;
    const parts = cue.index === null ? [timing] : [cue.index, timing];
    const [first = "", ...rest] = cue.lines;
    return [...parts, cue.prefix + first, ...rest].join(doc.eol);
  });
  return (
    blocks.map((block) => block + doc.eol).join(doc.eol) + (doc.trailingNewline ? doc.eol : "")
  );
}

function renderMicroDvd(doc: GeneratedDocument): string {
  const lines = doc.cues.map((cue, index) => {
    const start = 24 + index * 100;
    const end = start + 60;
    return `{${start.toString()}}{${end.toString()}}${renderCueText(cue, "|")}`;
  });
  const all = doc.withHeader ? ["{1}{1}23.976", ...lines] : lines;
  return all.join(doc.eol) + (doc.trailingNewline ? doc.eol : "");
}

function renderSubViewer(doc: GeneratedDocument): string {
  const blocks = doc.cues.map((cue) => {
    const timing = `${pad(cue.start.h, 2)}:${pad(cue.start.m, 2)}:${pad(cue.start.s, 2)}.${pad(Math.floor(cue.start.ms / 10), 2)},${pad(cue.end.h, 2)}:${pad(cue.end.m, 2)}:${pad(cue.end.s, 2)}.${pad(Math.floor(cue.end.ms / 10), 2)}`;
    return [timing, renderCueText(cue, "[br]")].join(doc.eol);
  });
  const body =
    blocks.map((block) => block + doc.eol).join(doc.eol) + (doc.trailingNewline ? doc.eol : "");
  if (!doc.withHeader) return body;
  const header = ["[INFORMATION]", "[TITLE]Property test", "[END INFORMATION]"].join(doc.eol);
  return header + doc.eol + doc.eol + body;
}

const RENDERERS: Record<SubtitleFormat, (doc: GeneratedDocument) => string> = {
  srt: renderSrt,
  microdvd: renderMicroDvd,
  subviewer: renderSubViewer,
};

describe("round-trip property", () => {
  for (const format of ["srt", "microdvd", "subviewer"] as const) {
    it(`serialise(parse(file)) is byte identical for generated ${format} files`, () => {
      fc.assert(
        fc.property(DOCUMENT, (generated) => {
          const text = RENDERERS[format](generated);
          const doc = parseSubtitleText(text, { format });
          expect(serialiseSubtitleDocument(doc)).toBe(text);
        }),
        { numRuns: 300 },
      );
    });

    it(`preserves cue count and every timing line for generated ${format} files`, () => {
      fc.assert(
        fc.property(DOCUMENT, (generated) => {
          const doc = parseSubtitleText(RENDERERS[format](generated), {
            format,
          });
          expect(doc.cues).toHaveLength(generated.cues.length);
          const reparsed = parseSubtitleText(serialiseSubtitleDocument(doc), { format });
          expect(reparsed.cues.map((cue) => cue.rawTimingLine)).toEqual(
            doc.cues.map((cue) => cue.rawTimingLine),
          );
          expect(reparsed.cues.map((cue) => cue.rawIndexLine)).toEqual(
            doc.cues.map((cue) => cue.rawIndexLine),
          );
        }),
        { numRuns: 200 },
      );
    });

    it(`counts the same billable characters however ${format} files are written`, () => {
      fc.assert(
        fc.property(DOCUMENT, (generated) => {
          const doc = parseSubtitleText(RENDERERS[format](generated), {
            format,
          });
          expect(doc.dialogueChars).toBe(documentDialogueChars(doc.cues));
          expect(doc.dialogueChars).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    });
  }

  it("is unaffected by the line ending a file happens to use", () => {
    fc.assert(
      fc.property(DOCUMENT, (generated) => {
        const lf = parseSubtitleText(renderSrt({ ...generated, eol: "\n" }), {
          format: "srt",
        });
        const crlf = parseSubtitleText(renderSrt({ ...generated, eol: "\r\n" }), { format: "srt" });
        expect(crlf.dialogueChars).toBe(lf.dialogueChars);
        expect(crlf.cues.map((cue) => cue.lines)).toEqual(lf.cues.map((cue) => cue.lines));
      }),
      { numRuns: 100 },
    );
  });
});
