import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DownloadUrls, base64ToBytes, buildZip, bytesToBase64 } from "./bytes.js";

describe("base64 round trip", () => {
  it("survives a file with a byte-order mark and non-Latin text", () => {
    const text = "﻿1\n00:00:01,000 --> 00:00:03,000\nЗдравей, свят!\n";
    const bytes = new TextEncoder().encode(text);
    const back = base64ToBytes(bytesToBase64(bytes));
    // Byte for byte, mark included: what goes into storage comes back out.
    expect([...back]).toEqual([...bytes]);
    expect([back[0], back[1], back[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("buildZip", () => {
  it("puts every finished file in, under its own name", () => {
    const zip = buildZip([
      { name: "episode-1.de.srt", bytes: new TextEncoder().encode("one") },
      { name: "episode-2.de.srt", bytes: new TextEncoder().encode("two") },
    ]);
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(["episode-1.de.srt", "episode-2.de.srt"]);
    expect(new TextDecoder().decode(entries["episode-1.de.srt"])).toBe("one");
  });

  it("keeps both files when a folder drop carried the same name twice", () => {
    const zip = buildZip([
      { name: "episode.de.srt", bytes: new TextEncoder().encode("first") },
      { name: "episode.de.srt", bytes: new TextEncoder().encode("second") },
    ]);
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(["episode.de (2).srt", "episode.de.srt"]);
  });
});

describe("DownloadUrls", () => {
  it("mints one URL per file and reuses it, so polling leaks nothing", () => {
    const urls = new DownloadUrls(
      (bytes, mime) => `${mime}:${bytes.length.toString()}:${counter++}`,
    );
    let counter = 0;
    const build = (): { bytes: Uint8Array; mime: string } => ({
      bytes: new Uint8Array(3),
      mime: "text/plain",
    });

    const first = urls.get("job_1", build);
    expect(urls.get("job_1", build)).toBe(first);

    urls.forget("job_1");
    expect(urls.get("job_1", build)).not.toBe(first);
  });
});
