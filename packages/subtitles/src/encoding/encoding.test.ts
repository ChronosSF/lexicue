import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { SubtitleRejectedError } from "../errors.js";
import {
  CANDIDATE_LEGACY_ENCODINGS,
  decodeSubtitleBytes,
  detectEncoding,
} from "./detect-encoding.js";
import { encodeSubtitleDocument, parseSubtitleBytes } from "./io.js";

const SRT_ASCII = ["1", "00:00:01,000 --> 00:00:03,000", "Hello there.", "", ""].join("\n");

function srtWith(text: string): string {
  return ["1", "00:00:01,000 --> 00:00:03,000", text, "", ""].join("\n");
}

describe("detectEncoding", () => {
  it("recognises UTF-8 with a byte-order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(SRT_ASCII)]);
    expect(detectEncoding(bytes)).toMatchObject({ encoding: "utf-8", bom: true });
  });

  it("recognises UTF-8 without a byte-order mark", () => {
    const bytes = new TextEncoder().encode(srtWith("Пример на кирилица."));
    expect(detectEncoding(bytes)).toMatchObject({ encoding: "utf-8", bom: false, confidence: 100 });
  });

  it("recognises pure ASCII as UTF-8", () => {
    expect(detectEncoding(new TextEncoder().encode(SRT_ASCII)).encoding).toBe("utf-8");
  });

  it("recognises UTF-16 in both byte orders from the mark", () => {
    expect(detectEncoding(iconv.encode(SRT_ASCII, "utf-16le", { addBOM: true }))).toMatchObject({
      encoding: "utf-16le",
      bom: true,
    });
    expect(detectEncoding(iconv.encode(SRT_ASCII, "utf-16be", { addBOM: true }))).toMatchObject({
      encoding: "utf-16be",
      bom: true,
    });
  });

  it("detects the legacy code pages the spec lists", () => {
    const cyrillic = srtWith("Здравей, свят! Какво правиш днес? Това е тест на български език.");
    expect(detectEncoding(iconv.encode(cyrillic, "windows-1251")).encoding).toBe("windows-1251");

    const czech = srtWith("Žluťoučký kůň úpěl ďábelské ódy. Přišel jsem, viděl jsem, zvítězil.");
    expect(detectEncoding(iconv.encode(czech, "windows-1250")).encoding).toBe("windows-1250");

    const greek = srtWith("Καλημέρα κόσμε, τι κάνεις σήμερα; Αυτό είναι ένα δοκιμαστικό κείμενο.");
    expect(["windows-1253", "iso-8859-7"]).toContain(
      detectEncoding(iconv.encode(greek, "windows-1253")).encoding,
    );
  });

  it("always returns a readable single-byte encoding rather than refusing a file", () => {
    const detected = detectEncoding(new Uint8Array([0x41, 0x92, 0x42]));
    expect(CANDIDATE_LEGACY_ENCODINGS as readonly string[]).toContain(detected.encoding);
  });
});

describe("decodeSubtitleBytes", () => {
  it("round trips a Windows-1251 file to the same text", () => {
    const text = srtWith("Здравей, свят! Какво правиш днес? Това е тест на български език.");
    const decoded = decodeSubtitleBytes(iconv.encode(text, "windows-1251"));
    expect(decoded.text).toBe(text);
    expect(decoded.encoding).toBe("windows-1251");
    expect(decoded.bom).toBe(false);
  });

  it("removes the byte-order mark from the decoded text", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(SRT_ASCII)]);
    const decoded = decodeSubtitleBytes(bytes);
    expect(decoded.text).toBe(SRT_ASCII);
    expect(decoded.bom).toBe(true);
  });

  it("falls back to windows-1252 when asked for an encoding nothing supports", () => {
    const decoded = decodeSubtitleBytes(new TextEncoder().encode(SRT_ASCII), {
      encoding: "not-a-real-encoding",
    });
    expect(decoded.encoding).toBe("windows-1252");
    expect(decoded.text).toBe(SRT_ASCII);
  });

  it("honours an explicitly chosen encoding", () => {
    const text = srtWith("Naïve café");
    const decoded = decodeSubtitleBytes(iconv.encode(text, "iso-8859-1"), {
      encoding: "iso-8859-1",
    });
    expect(decoded.text).toBe(text);
    expect(decoded.encoding).toBe("iso-8859-1");
  });
});

describe("parseSubtitleBytes", () => {
  it("decodes and parses a Windows-1251 file and records the encoding", () => {
    const text = srtWith("Здравей, свят! Какво правиш днес? Това е тест на български език.");
    const doc = parseSubtitleBytes(iconv.encode(text, "windows-1251"), { fileName: "bg.srt" });
    expect(doc.encoding).toBe("windows-1251");
    expect(doc.cues).toHaveLength(1);
    expect(doc.cues[0]?.lines[0]).toBe(
      "Здравей, свят! Какво правиш днес? Това е тест на български език.",
    );
  });

  it("refuses image-based bytes before it tries to decode them", () => {
    const vobsub = new Uint8Array([0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00]);
    expect(() => parseSubtitleBytes(vobsub, { fileName: "movie.sub" })).toThrow(
      SubtitleRejectedError,
    );
  });
});

describe("encodeSubtitleDocument", () => {
  it("writes UTF-8 with a byte-order mark by default and without one on request", () => {
    const doc = parseSubtitleBytes(new TextEncoder().encode(SRT_ASCII), { fileName: "a.srt" });
    const withBom = encodeSubtitleDocument(doc);
    const withoutBom = encodeSubtitleDocument(doc, { bom: false });
    expect(Array.from(withBom.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(Array.from(withoutBom.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(withoutBom)).toBe(SRT_ASCII);
  });

  it("writes a Windows-1251 source back out as UTF-8", () => {
    const text = srtWith("Здравей, свят! Какво правиш днес? Това е тест на български език.");
    const doc = parseSubtitleBytes(iconv.encode(text, "windows-1251"), { fileName: "bg.srt" });
    const out = encodeSubtitleDocument(doc, { bom: false });
    expect(new TextDecoder("utf-8", { fatal: true }).decode(out)).toBe(text);
  });
});
