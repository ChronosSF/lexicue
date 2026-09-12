import { parseSubtitleText } from "@lexicue/subtitles";
import { describe, expect, it } from "vitest";
import { FakeTranslationModelClient } from "./clients/fake.js";
import { FaultInjectingModelClient } from "./clients/fault.js";
import { resolveConfig, type HarnessConfig } from "./config.js";
import { findTargetLanguage } from "./languages.js";
import type { Character } from "./schemas.js";
import { translateUpload } from "./translate-upload.js";
import type { TranslationJob, TranslationOptions } from "./types.js";

/**
 * The three-episode season fixture of spec section 10.2. Marta is in every
 * episode. Ivo is introduced in episode two, and deliberately late enough that
 * he is outside the 150-cue sample the season glossary is built from, so the
 * only way he can reach episode three is through episode two's own glossary.
 */
function episode(
  number: number,
  options: { introduceIvo?: boolean; contradictMarta?: boolean } = {},
): string {
  const blocks: string[] = [];
  const total = 200;
  for (let i = 1; i <= total; i += 1) {
    const seconds = i % 60;
    const minutes = Math.floor(i / 60) % 60;
    const stamp = `00:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    let text = `MARTA: Line ${i.toString()} of episode ${number.toString()}.`;
    if (i === 1) text = `EPISODE ${number.toString()}`;
    // The running joke every episode repeats.
    if (i % 50 === 0) text = "MARTA: The lamp is fine. The lamp is always fine.";
    // Both of the lines below sit past cue 150, so the season sample never sees
    // them and only the file's own glossary pass can discover them.
    if (options.introduceIvo === true && i > 170 && i < 190) {
      text = `IVO: Line ${i.toString()}, and the tender is late again.`;
    }
    if (options.contradictMarta === true && i === 195) {
      text = "MARTA: Down south they write it Martha.";
    }
    blocks.push(`${i.toString()}\n${stamp},000 --> ${stamp},900\n${text}\n`);
  }
  return blocks.join("\n") + "\n";
}

function seasonJobs(): TranslationJob[] {
  return [
    { jobId: "s01e01", fileName: "s01e01.srt", document: parseSubtitleText(episode(1)) },
    {
      jobId: "s01e02",
      fileName: "s01e02.srt",
      document: parseSubtitleText(episode(2, { introduceIvo: true })),
    },
    {
      jobId: "s01e03",
      fileName: "s01e03.srt",
      document: parseSubtitleText(episode(3, { introduceIvo: true, contradictMarta: true })),
    },
  ];
}

/**
 * A glossary that reads the text it was given: Marta everywhere, Ivo only where
 * he actually speaks, and — in episode three — a rendering of Marta that
 * contradicts the season's, which the merge must override.
 */
function charactersFromSource(sourceText: string): Character[] {
  const characters: Character[] = [];
  if (sourceText.includes("MARTA")) {
    characters.push({
      name: "Marta",
      rendered: sourceText.includes("write it Martha") ? "Martha" : "Marta",
      notes: "the keeper",
    });
  }
  if (sourceText.includes("IVO")) {
    characters.push({ name: "Ivo", rendered: "Ivo", notes: "the deckhand" });
  }
  return characters;
}

function options(lane: "fast" | "economy" = "fast"): TranslationOptions {
  const target = findTargetLanguage("de");
  if (target === undefined) throw new Error("de missing");
  return {
    target,
    lane,
    formality: "auto",
    contextNote: "",
    lineHandling: "reflow",
    translateLyrics: true,
  };
}

function config(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return resolveConfig({ batchSize: 100, concurrency: 4, ...overrides });
}

/** Every glossary request the client was given, in order. */
function glossaryRequests(client: FakeTranslationModelClient): string[] {
  return client.requests
    .filter((request) => request.purpose === "glossary")
    .map((request) => request.user.at(-1)?.text ?? "");
}

describe("the season glossary", () => {
  it("is built from a sample of every file before any file is translated", async () => {
    const client = new FakeTranslationModelClient({ charactersFromSource });
    const result = await translateUpload({
      client,
      config: config(),
      options: options(),
      jobs: seasonJobs(),
    });
    expect(result.seasonSample?.includedFiles).toEqual(["s01e01.srt", "s01e02.srt", "s01e03.srt"]);
    const seasonRequest = client.requests[0];
    expect(seasonRequest?.purpose).toBe("season-glossary");
    // Ivo speaks only after cue 170, outside the 150-cue sample.
    expect(seasonRequest?.user[0]?.text).not.toContain("IVO");
  });

  it("carries a character introduced in episode two through to episode three", async () => {
    const client = new FakeTranslationModelClient({ charactersFromSource });
    const result = await translateUpload({
      client,
      config: config(),
      options: options(),
      jobs: seasonJobs(),
    });

    const requests = glossaryRequests(client);
    expect(requests).toHaveLength(3);
    // Episode one's glossary pass has never heard of Ivo.
    expect(requests[0]).not.toContain("Ivo");
    // Episode two's has not either: it is about to discover him.
    expect(requests[1]).not.toContain("Ivo");
    // Episode three's carries him in the season glossary it must not contradict.
    expect(requests[2]).toContain("Ivo -> Ivo (the deckhand)");

    expect(result.seasonGlossary?.characters.map((character) => character.name)).toEqual([
      "Marta",
      "Ivo",
    ]);
  });

  it("never lets a later episode contradict what the season fixed", async () => {
    const client = new FakeTranslationModelClient({ charactersFromSource });
    const result = await translateUpload({
      client,
      config: config(),
      options: options(),
      jobs: seasonJobs(),
    });
    // Episode three's own glossary calls her Martha; the season says Marta.
    const marta = result.seasonGlossary?.characters.find((character) => character.name === "Marta");
    expect(marta?.rendered).toBe("Marta");
    expect(result.files[2]?.glossary.characters[0]?.rendered).toBe("Marta");
  });

  it("gives every episode's batches the same shared glossary", async () => {
    const client = new FakeTranslationModelClient({ charactersFromSource });
    await translateUpload({
      client,
      config: config(),
      options: options(),
      jobs: seasonJobs(),
    });
    const batchesOfEpisodeThree = client.requests.filter(
      (request) => request.purpose === "batch" && request.jobId === "s01e03",
    );
    expect(batchesOfEpisodeThree.length).toBeGreaterThan(1);
    for (const request of batchesOfEpisodeThree) {
      expect(request.user.at(-1)?.text).toContain("Marta -> Marta");
      expect(request.user.at(-1)?.text).toContain("Ivo -> Ivo");
    }
  });

  it("reports the shared glossary in the upload summary", async () => {
    const client = new FakeTranslationModelClient({ charactersFromSource });
    const result = await translateUpload({
      client,
      config: config(),
      options: options(),
      jobs: seasonJobs(),
    });
    expect(result.report.seasonGlossary).toMatchObject({
      applied: true,
      characters: 2,
      sampledFiles: ["s01e01.srt", "s01e02.srt", "s01e03.srt"],
      droppedFiles: [],
    });
    expect(result.report.files).toHaveLength(3);
    expect(result.report.totalCues).toBe(600);
    expect(result.report.totalPriceCents).toBeGreaterThan(0);
  });

  it("runs no season pass at all for a single file", async () => {
    const client = new FakeTranslationModelClient({ charactersFromSource });
    const result = await translateUpload({
      client,
      config: config(),
      options: options(),
      jobs: seasonJobs().slice(0, 1),
    });
    expect(client.requests.some((request) => request.purpose === "season-glossary")).toBe(false);
    expect(result.report.seasonGlossary).toBeNull();
  });
});

describe("the season on the economy lane", () => {
  it("puts every episode's batches into one Message Batch and produces the same files", async () => {
    const jobs = seasonJobs();
    const fastClient = new FakeTranslationModelClient({ charactersFromSource });
    const fast = await translateUpload({
      client: fastClient,
      config: config(),
      options: options("fast"),
      jobs,
    });

    const economyClient = new FakeTranslationModelClient({ charactersFromSource });
    const economy = await translateUpload({
      client: economyClient,
      config: config(),
      options: options("economy"),
      jobs,
      collect: { wait: () => Promise.resolve() },
    });

    expect(economy.files.map((file) => file.text)).toEqual(fast.files.map((file) => file.text));
    expect(economy.files[2]?.glossary.characters.map((character) => character.name)).toEqual([
      "Marta",
      "Ivo",
    ]);
  });

  it("resolves an errored entry by retrying those cues interactively", async () => {
    const jobs = seasonJobs().slice(0, 2);
    const client = new FaultInjectingModelClient(
      new FakeTranslationModelClient({ charactersFromSource }),
      { batchOutcomes: { s01e02_1: "errored" } },
    );
    const result = await translateUpload({
      client,
      config: config(),
      options: options("economy"),
      jobs,
      collect: { wait: () => Promise.resolve() },
    });
    expect(result.files[1]?.report.untranslatedCues).toEqual([]);
    expect(result.files[1]?.report.totalCues).toBe(200);
  });
});
