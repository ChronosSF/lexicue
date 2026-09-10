import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { priceCents } from "@subtitle-translator/pricing";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { intake, totalCents, usableFiles, type RawFile } from "./local-files.js";

/**
 * What the upload screen does before anything reaches the backend: unpack,
 * parse, price, and explain the files it cannot use.
 */

const SAMPLES = [
  resolve(process.cwd(), "public/samples"),
  resolve(process.cwd(), "apps/web/public/samples"),
].find((candidate) => existsSync(candidate));

function sample(path: string): RawFile {
  if (SAMPLES === undefined) throw new Error("the sample files are missing");
  return {
    name: path.split("/").pop() ?? path,
    bytes: new Uint8Array(readFileSync(resolve(SAMPLES, path))),
  };
}

describe("intake", () => {
  it("parses a SubRip file and prices it on both lanes", () => {
    const { files } = intake([sample("the-lamp-room.srt")]);
    const file = files[0];
    expect(file?.problem).toBeNull();
    expect(file?.preview).toMatchObject({ format: "srt", encoding: "utf-8" });
    expect(file?.preview?.cueCount).toBe(38);
    expect(file?.preview?.priceCents.fast).toBe(
      priceCents(file?.preview?.dialogueChars ?? 0, "fast"),
    );
    expect(file?.preview?.priceCents.economy).toBe(
      priceCents(file?.preview?.dialogueChars ?? 0, "economy"),
    );
    expect(file?.preview?.runningTimeMs).toBeGreaterThan(0);
  });

  it("recognises both .sub dialects by their content", () => {
    const { files } = intake([
      sample("formats/the-lamp-room.microdvd.sub"),
      sample("formats/the-lamp-room.subviewer.sub"),
    ]);
    expect(files.map((file) => file.preview?.format)).toEqual(["microdvd", "subviewer"]);
  });

  it("charges the same for the same dialogue in a different format", () => {
    const { files } = intake([
      sample("the-lamp-room.srt"),
      sample("formats/the-lamp-room.subviewer.sub"),
    ]);
    const [srt, subviewer] = files;
    expect(subviewer?.preview?.dialogueChars).toBe(srt?.preview?.dialogueChars);
  });

  it("unpacks a zip and notes what it ignored", () => {
    const zip = zipSync({
      "season/skerry-point-s01e01.srt": sample("season/skerry-point-s01e01.srt").bytes,
      "season/skerry-point-s01e02.srt": sample("season/skerry-point-s01e02.srt").bytes,
      "season/poster.jpg": new Uint8Array([1, 2, 3]),
      "__MACOSX/._skerry": new Uint8Array([0]),
    });

    const result = intake([{ name: "season.zip", bytes: zip }]);
    expect(result.files.map((file) => file.fileName)).toEqual([
      "skerry-point-s01e01.srt",
      "skerry-point-s01e02.srt",
    ]);
    expect(result.ignored).toEqual(["poster.jpg"]);
    expect(result.files.every((file) => file.preview !== null)).toBe(true);
  });

  it("explains a file it cannot use, in the words the package reserves for it", () => {
    const { files } = intake([
      { name: "notes.srt", bytes: new TextEncoder().encode("not a subtitle") },
    ]);
    expect(files[0]?.preview).toBeNull();
    expect(files[0]?.problem).toContain("format was not recognised");
  });

  it("refuses a .sub whose .idx arrived in an earlier drop", () => {
    const first = intake([{ name: "film.idx", bytes: new TextEncoder().encode("# VobSub index") }]);
    expect(first.ignored).toEqual(["film.idx"]);

    const second = intake(
      [{ name: "film.sub", bytes: sample("formats/the-lamp-room.microdvd.sub").bytes }],
      first.ignored,
    );
    expect(second.files[0]?.problem).toContain("image-based");
  });

  it("refuses an image-based pair dropped together", () => {
    const idx: RawFile = { name: "film.idx", bytes: new TextEncoder().encode("# VobSub index") };
    const sub: RawFile = {
      name: "film.sub",
      bytes: sample("formats/the-lamp-room.microdvd.sub").bytes,
    };
    const { files } = intake([idx, sub]);
    const subtitle = files.find((file) => file.fileName === "film.sub");
    expect(subtitle?.problem).toContain("image-based");
  });

  it("refuses a binary file before trying to decode it", () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00]);
    const { files } = intake([{ name: "movie.sub", bytes }]);
    expect(files[0]?.problem).toContain("image-based");
  });
});

describe("totals", () => {
  it("counts only the files that can be translated", () => {
    const { files } = intake([
      sample("the-lamp-room.srt"),
      { name: "broken.srt", bytes: new TextEncoder().encode("nonsense") },
    ]);
    expect(usableFiles(files)).toHaveLength(1);
    expect(totalCents(files, "fast")).toBe(files[0]?.preview?.priceCents.fast);
  });
});
