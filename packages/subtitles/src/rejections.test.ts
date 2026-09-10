import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertNoImageCompanion,
  assertTextSubtitleBytes,
  hasImageCompanion,
  inspectBytes,
} from "./detect.js";
import { parseSubtitleBytes } from "./encoding/io.js";
import { REJECTION_MESSAGES, SubtitleRejectedError, type RejectionCode } from "./errors.js";
import { MAX_CUES_PER_FILE, MAX_FILE_BYTES } from "./limits.js";
import { parseSubtitleText } from "./parse.js";

const FIXTURES = fileURLToPath(new URL("./__fixtures__/rejected/", import.meta.url));

function read(name: string): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURES + name));
}

/** Every rejection in spec section 10.1, with the sentence the user is shown. */
const CORPUS: { file: string; code: RejectionCode; why: string }[] = [
  { file: "vobsub.sub", code: "image-based", why: "a VobSub MPEG stream" },
  { file: "pgs.sup", code: "image-based", why: "a PGS bitmap stream" },
  { file: "empty.srt", code: "empty", why: "a zero-byte file" },
  { file: "blank.srt", code: "empty", why: "a file of nothing but whitespace" },
  { file: "not-a-subtitle.txt", code: "unknown-format", why: "plain prose with no timings" },
  { file: "no-cues.srt", code: "no-cues", why: "a header with no cues after it" },
];

describe.each(CORPUS)("rejecting $file", ({ file, code, why }) => {
  it(`refuses ${why} with the ${code} message`, () => {
    let thrown: unknown;
    try {
      parseSubtitleBytes(read(file), { fileName: file });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SubtitleRejectedError);
    const rejected = thrown as SubtitleRejectedError;
    expect(rejected.code).toBe(code);
    expect(rejected.message).toBe(REJECTION_MESSAGES[code]);
    expect(rejected.fileName).toBe(file);
  });
});

describe("VobSub companions", () => {
  it("refuses a .sub that has a .idx next to it", () => {
    const siblings = ["movie.sub", "movie.idx", "movie.mkv"];
    expect(hasImageCompanion("movie.sub", siblings)).toBe(true);
    expect(() => {
      assertNoImageCompanion("movie.sub", siblings);
    }).toThrow(REJECTION_MESSAGES["image-based"]);
  });

  it("matches the companion regardless of letter case", () => {
    expect(hasImageCompanion("Movie.SUB", ["MOVIE.IDX"])).toBe(true);
  });

  it("lets a lone .sub through", () => {
    expect(hasImageCompanion("movie.sub", ["movie.mkv", "other.idx"])).toBe(false);
    expect(() => {
      assertNoImageCompanion("movie.sub", ["movie.mkv"]);
    }).not.toThrow();
  });

  it("ignores the companion rule for .srt files", () => {
    expect(hasImageCompanion("movie.srt", ["movie.idx"])).toBe(false);
  });
});

describe("size and cue limits", () => {
  it("refuses a file over the size cap before decoding it", () => {
    const oversized = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x41);
    expect(inspectBytes(oversized, "big.srt")).toBe("too-large");
    expect(() => {
      assertTextSubtitleBytes(oversized, "big.srt");
    }).toThrow(REJECTION_MESSAGES["too-large"]);
  });

  it("refuses a file over the cue cap", () => {
    const cues: string[] = [];
    for (let i = 1; i <= MAX_CUES_PER_FILE + 1; i += 1) {
      const seconds = i % 60;
      const minutes = Math.floor(i / 60) % 60;
      const stamp = `00:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
      cues.push(`${i.toString()}\n${stamp},000 --> ${stamp},900\nLine ${i.toString()}.\n`);
    }
    expect(() => parseSubtitleText(cues.join("\n"), { fileName: "long.srt" })).toThrow(
      REJECTION_MESSAGES["too-many-cues"],
    );
  });

  it("accepts a file exactly at the cue cap", () => {
    const cues: string[] = [];
    for (let i = 1; i <= MAX_CUES_PER_FILE; i += 1) {
      const seconds = i % 60;
      const minutes = Math.floor(i / 60) % 60;
      const stamp = `00:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
      cues.push(`${i.toString()}\n${stamp},000 --> ${stamp},900\nLine ${i.toString()}.\n`);
    }
    expect(parseSubtitleText(cues.join("\n")).cues).toHaveLength(MAX_CUES_PER_FILE);
  });
});

describe("inspectBytes", () => {
  it("lets a plain UTF-8 subtitle file through", () => {
    const bytes = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHi.\n\n");
    expect(inspectBytes(bytes, "a.srt")).toBeNull();
  });

  it("treats an embedded NUL byte as binary", () => {
    expect(inspectBytes(new Uint8Array([0x41, 0x00, 0x42]), "a.srt")).toBe("binary");
  });

  it("does not mistake UTF-16 for a binary file", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
    expect(inspectBytes(utf16, "a.srt")).toBeNull();
  });

  it("does not mistake text starting with PG for a PGS stream", () => {
    const bytes = new TextEncoder().encode(
      "PG rated feature\n1\n00:00:01,000 --> 00:00:02,000\nHi.",
    );
    expect(inspectBytes(bytes, "a.srt")).toBeNull();
  });

  it("recognises a PGS stream from its .sup extension", () => {
    expect(inspectBytes(read("pgs.sup"), "movie.sup")).toBe("image-based");
  });
});

describe("every rejection message", () => {
  it("is a complete sentence the user can act on", () => {
    for (const message of Object.values(REJECTION_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
      expect(message.endsWith(".")).toBe(true);
      expect(message).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});
