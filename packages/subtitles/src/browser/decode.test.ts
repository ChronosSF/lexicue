import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { decodeSubtitleBytes, detectEncoding } from "../encoding/detect-encoding.js";
import { parseSubtitleBytes } from "../encoding/io.js";
import { SubtitleRejectedError } from "../errors.js";
import {
  BROWSER_LEGACY_ENCODINGS,
  decodeSubtitleBytesInBrowser,
  detectEncodingInBrowser,
  parseSubtitleBytesInBrowser,
} from "./decode.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url))));

const SRT_ASCII = ["1", "00:00:01,000 --> 00:00:03,000", "Hello there.", "", ""].join("\n");

function srtWith(text: string): string {
  return ["1", "00:00:01,000 --> 00:00:03,000", text, "", ""].join("\n");
}

const CYRILLIC = srtWith("Здравей, свят! Какво правиш днес? Това е тест на български език.");
const CZECH = srtWith("Žluťoučký kůň úpěl ďábelské ódy. Přišel jsem, viděl jsem, zvítězil.");
const GREEK = srtWith("Καλημέρα κόσμε, τι κάνεις σήμερα; Αυτό είναι ένα δοκιμαστικό κείμενο.");
const FRENCH = srtWith("Écoutez-moi. Où êtes-vous allés hier soir, après la répétition ?");

describe("detectEncodingInBrowser", () => {
  it("recognises UTF-8 with and without a byte-order mark", () => {
    const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(SRT_ASCII)]);
    expect(detectEncodingInBrowser(withMark)).toMatchObject({ encoding: "utf-8", bom: true });
    expect(detectEncodingInBrowser(new TextEncoder().encode(CYRILLIC))).toMatchObject({
      encoding: "utf-8",
      bom: false,
      confidence: 100,
    });
  });

  it("recognises UTF-16 in both byte orders from the mark", () => {
    expect(
      detectEncodingInBrowser(iconv.encode(SRT_ASCII, "utf-16le", { addBOM: true })),
    ).toMatchObject({ encoding: "utf-16le", bom: true });
    expect(
      detectEncodingInBrowser(iconv.encode(SRT_ASCII, "utf-16be", { addBOM: true })),
    ).toMatchObject({ encoding: "utf-16be", bom: true });
  });

  it("detects the legacy code pages the specification lists", () => {
    expect(detectEncodingInBrowser(iconv.encode(CYRILLIC, "windows-1251")).encoding).toBe(
      "windows-1251",
    );
    expect(detectEncodingInBrowser(iconv.encode(CZECH, "windows-1250")).encoding).toBe(
      "windows-1250",
    );
    expect(["windows-1253", "iso-8859-7"]).toContain(
      detectEncodingInBrowser(iconv.encode(GREEK, "windows-1253")).encoding,
    );
    expect(["windows-1252", "windows-1254", "windows-1257", "windows-1258"]).toContain(
      detectEncodingInBrowser(iconv.encode(FRENCH, "windows-1252")).encoding,
    );
  });

  it("always returns a readable single-byte encoding rather than refusing a file", () => {
    const detected = detectEncodingInBrowser(new Uint8Array([0x41, 0x92, 0x42]));
    expect(BROWSER_LEGACY_ENCODINGS as readonly string[]).toContain(detected.encoding);
  });
});

describe("agreement with the detector the server runs", () => {
  const cases: [string, Uint8Array][] = [
    ["utf-8 with a mark", new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(GREEK)])],
    ["utf-8 without a mark", new TextEncoder().encode(CYRILLIC)],
    ["ascii", new TextEncoder().encode(SRT_ASCII)],
    ["windows-1251", iconv.encode(CYRILLIC, "windows-1251")],
    ["windows-1250", iconv.encode(CZECH, "windows-1250")],
    ["the windows-1251 fixture", fixture("srt-windows-1251.srt")],
  ];

  it.each(cases)("reads %s to the same text and the same character count", (_name, bytes) => {
    const server = decodeSubtitleBytes(bytes);
    const browser = decodeSubtitleBytesInBrowser(bytes);
    expect(browser.encoding).toBe(server.encoding);
    expect(browser.text).toBe(server.text);
    expect(browser.bom).toBe(server.bom);

    // The count the browser shows is the count the server charges (spec 10.1).
    expect(parseSubtitleBytesInBrowser(bytes).dialogueChars).toBe(
      parseSubtitleBytes(bytes).dialogueChars,
    );
  });
});

describe("parseSubtitleBytesInBrowser", () => {
  it("parses every text fixture exactly as the server does", () => {
    for (const name of [
      "srt-basic.srt",
      "srt-bom.srt",
      "srt-crlf.srt",
      "srt-position-hints.srt",
      "srt-nested-tags.srt",
      "srt-windows-1251.srt",
      "microdvd-basic.sub",
      "microdvd-control-codes.sub",
      "subviewer-basic.sub",
    ]) {
      const bytes = fixture(name);
      expect(parseSubtitleBytesInBrowser(bytes, { fileName: name })).toStrictEqual(
        parseSubtitleBytes(bytes, { fileName: name }),
      );
    }
  });

  it("refuses image-based and binary files before decoding them", () => {
    expect(() =>
      parseSubtitleBytesInBrowser(fixture("rejected/vobsub.sub"), { fileName: "vobsub.sub" }),
    ).toThrow(SubtitleRejectedError);
    expect(() =>
      parseSubtitleBytesInBrowser(fixture("rejected/pgs.sup"), { fileName: "pgs.sup" }),
    ).toThrow(SubtitleRejectedError);
    expect(() => parseSubtitleBytesInBrowser(new Uint8Array())).toThrow(SubtitleRejectedError);
  });

  it("honours an encoding the caller forces", () => {
    const bytes = iconv.encode(CYRILLIC, "windows-1251");
    const decoded = decodeSubtitleBytesInBrowser(bytes, { encoding: "windows-1252" });
    expect(decoded.encoding).toBe("windows-1252");
    expect(decoded.confidence).toBe(100);
    expect(decoded.text).not.toContain("Здравей");
  });

  it("falls back to windows-1252 when asked for a label the browser does not know", () => {
    const bytes = iconv.encode(CZECH, "windows-1250");
    expect(decodeSubtitleBytesInBrowser(bytes, { encoding: "not-an-encoding" }).encoding).toBe(
      "windows-1252",
    );
  });
});

describe("the two detectors on the same fixture corpus", () => {
  it("agree on every fixture that is not deliberately broken", () => {
    for (const name of ["srt-basic.srt", "srt-bom.srt", "srt-windows-1251.srt"]) {
      const bytes = fixture(name);
      expect(detectEncodingInBrowser(bytes).encoding).toBe(detectEncoding(bytes).encoding);
    }
  });
});
