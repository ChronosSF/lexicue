import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HARNESS_CONFIG } from "@lexicue/harness";
import { priceFile } from "@lexicue/pricing";
import { parseSubtitleText } from "@lexicue/subtitles";
import {
  EVAL_TARGETS,
  loadCorpus,
  loadManifest,
  seasonEntries,
  standaloneEntries,
} from "./corpus.js";
import { FakeJudgeModelClient } from "./fake-judge.js";
import { checkNameConsistency, judgeFile, renderJudgeRequest, stratifiedSample } from "./judge.js";
import { hardMetricsPassed, measureFile, previewPrice } from "./metrics.js";
import { JUDGE_RUBRIC, RUBRIC_VERSION } from "./rubric.js";
import { runEval, summarise, writeResults } from "./runner.js";

let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "subtitle-evals-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("the corpus", () => {
  const manifest = loadManifest();
  const corpus = loadCorpus();

  it("says in the manifest that nothing was copied from a real release", () => {
    expect(manifest.note).toContain("written for this project");
  });

  it("parses every file it lists", () => {
    expect(corpus).toHaveLength(manifest.files.length);
    for (const entry of corpus) {
      expect(entry.job.document.cues.length).toBeGreaterThan(0);
      expect(entry.job.document.format).toBe(entry.file.format);
      expect(entry.job.document.warnings).toEqual([]);
    }
  });

  it("covers the genres spec section 10.4 asks for", () => {
    const genres = new Set(manifest.files.map((file) => file.genre));
    expect(genres).toEqual(new Set(["comedy", "drama", "documentary"]));
  });

  it("includes a hearing-impaired edition with sounds, labels and lyrics", () => {
    const entry = corpus.find((candidate) => candidate.file.hearingImpaired === true);
    expect(entry).toBeDefined();
    const text = entry?.job.document.cues.map((cue) => cue.lines.join(" ")).join("\n") ?? "";
    expect(text).toMatch(/\[[a-z].*\]/);
    expect(text).toMatch(/[A-Z]{2,}:/);
    expect(text).toContain("♪");
  });

  it("covers all three formats and the three source languages", () => {
    expect(new Set(manifest.files.map((file) => file.format))).toEqual(
      new Set(["srt", "microdvd", "subviewer"]),
    );
    expect(new Set(manifest.files.map((file) => file.sourceLanguage))).toEqual(
      new Set(["en", "de", "es"]),
    );
  });

  it("prices the same dialogue identically in all three formats", () => {
    const byPath = new Map(corpus.map((entry) => [entry.file.path, entry]));
    const original = byPath.get("comedy/the-lamp-room.srt");
    for (const entry of corpus) {
      if (entry.file.sameDialogueAs === undefined) continue;
      expect(byPath.get(entry.file.sameDialogueAs)).toBe(original);
      expect(entry.job.document.dialogueChars).toBe(original?.job.document.dialogueChars);
    }
  });

  it("has a three-episode season that shares characters and a running joke", () => {
    const season = seasonEntries(corpus, "skerry-point");
    expect(season.map((entry) => entry.file.episode)).toEqual([1, 2, 3]);
    for (const entry of season) {
      const text = entry.job.document.cues.map((cue) => cue.lines.join(" ")).join("\n");
      expect(text).toContain("Marta");
      expect(text).toContain("Light");
      expect(text).toMatch(/gull|stair|landing/i);
    }
    // Petar is introduced in episode two and returns in episode three.
    const [, second, third] = season;
    expect(second?.job.document.cues.some((cue) => cue.lines.join(" ").includes("Petar"))).toBe(
      true,
    );
    expect(third?.job.document.cues.some((cue) => cue.lines.join(" ").includes("Petar"))).toBe(
      true,
    );
  });

  /**
   * Everything else in the corpus is 23 to 39 cues, which is a single batch:
   * it can never read the prompt cache, and its fixed costs are never
   * amortised, so it cannot say anything about the per-file cost model of spec
   * section 5.3. These two can.
   */
  it("has two full-length fixtures, each of several batches", () => {
    const byPath = new Map(corpus.map((entry) => [entry.file.path, entry]));
    const expected = [
      { path: "drama/the-signal-box.srt", cues: 400, batches: 4 },
      { path: "comedy/the-inventory.srt", cues: 1000, batches: 9 },
    ];
    for (const { path, cues, batches } of expected) {
      const document = byPath.get(path)?.job.document;
      expect(document?.cues).toHaveLength(cues);
      expect(document?.warnings).toEqual([]);
      expect(Math.ceil(cues / DEFAULT_HARNESS_CONFIG.batchSize)).toBe(batches);
    }
  });

  /**
   * The 10-cent floor decides the price of every short fixture, so none of them
   * exercises the metered rate. Both of these are priced by the rate on both
   * lanes, and the economy price is two thirds of the fast one as section 6.2
   * says it should be.
   */
  it("prices the full-length fixtures by the metered rate, not the 10-cent floor", () => {
    const byPath = new Map(corpus.map((entry) => [entry.file.path, entry]));
    for (const path of ["drama/the-signal-box.srt", "comedy/the-inventory.srt"]) {
      const document = byPath.get(path)?.job.document;
      expect(document).toBeDefined();
      if (document === undefined) continue;
      expect(document.dialogueChars).toBeGreaterThan(10_000);
      for (const lane of ["fast", "economy"] as const) {
        const price = priceFile(document.dialogueChars, lane);
        expect(price.atMinimum).toBe(false);
        expect(price.priceCents).toBe(previewPrice(document, lane));
      }
      expect(previewPrice(document, "economy")).toBeLessThan(previewPrice(document, "fast"));
    }
  });

  /**
   * A motif that appears in one batch proves nothing. These appear in every
   * batch of their file, which is what makes a real run able to show whether
   * the cached prefix is keeping a phrase consistent across parallel requests.
   */
  it("carries a recurring line through every batch of each full-length fixture", () => {
    const byPath = new Map(corpus.map((entry) => [entry.file.path, entry]));
    const motifs = [
      { path: "drama/the-signal-box.srt", line: "The line doesn't care.", batches: 4 },
      { path: "comedy/the-inventory.srt", line: "Count it twice, say it once.", batches: 9 },
    ];
    for (const { path, line, batches } of motifs) {
      const cues = byPath.get(path)?.job.document.cues ?? [];
      const hit = new Set<number>();
      for (const cue of cues) {
        if (!cue.lines.join(" ").includes(line)) continue;
        hit.add(Math.floor((cue.id - 1) / DEFAULT_HARNESS_CONFIG.batchSize));
      }
      expect(hit.size).toBe(batches);
    }
  });

  it("separates the season from the standalone files", () => {
    expect(standaloneEntries(corpus)).toHaveLength(corpus.length - 3);
  });

  it("names the eight targets of spec section 10.4", () => {
    expect(EVAL_TARGETS).toEqual(["de", "es", "fr", "pl", "bg", "el", "ja", "hi"]);
  });
});

describe("the hard metrics", () => {
  const source = parseSubtitleText(
    [
      "1",
      "00:00:01,000 --> 00:00:03,000",
      "<i>Hello.</i>",
      "",
      "2",
      "00:00:04,000 --> 00:00:05,000",
      "Goodbye.",
      "",
      "",
    ].join("\n"),
  );
  const good = [
    "1",
    "00:00:01,000 --> 00:00:03,000",
    "<i>Hallo.</i>",
    "",
    "2",
    "00:00:04,000 --> 00:00:05,000",
    "Tschüss.",
    "",
    "",
  ].join("\n");

  function report(
    overrides: Record<string, unknown> = {},
  ): Parameters<typeof measureFile>[0]["report"] {
    return {
      file: "a.srt",
      format: "srt",
      encoding: "utf-8",
      bom: false,
      lane: "fast",
      targetLanguage: "de",
      model: "claude-sonnet-5",
      fallbackModelUsed: false,
      promptVersion: "v3",
      effort: "medium",
      batchSize: 120,
      batches: 1,
      totalCues: 2,
      translatedCues: 2,
      untranslatedCues: [],
      glossaryEntriesApplied: 0,
      seasonGlossaryApplied: false,
      readingSpeedFindings: [],
      longLines: [],
      repairs: [],
      warnings: [],
      dialogueChars: source.dialogueChars,
      priceCents: previewPrice(source, "fast"),
      wallTimeMs: 100,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 70,
        cacheCreation5mInputTokens: 30,
        cacheCreation1hInputTokens: 0,
      },
      modelCostUsd: 0.001,
      cost: {
        cacheWriteUsd: 0,
        cacheReadUsd: 0,
        uncachedInputUsd: 0,
        outputUsd: 0,
        totalUsd: 0.001,
      },
      ...overrides,
    };
  }

  function measure(outputText: string, overrides: Record<string, unknown> = {}) {
    return measureFile({
      source,
      outputText,
      report: report(overrides),
      previewPriceCents: previewPrice(source, "fast"),
      target: "de",
      lane: "fast",
    });
  }

  it("passes a faithful translation", () => {
    const metrics = measure(good);
    expect(metrics.hard).toMatchObject({
      structuralFidelity: true,
      tagPreservation: true,
      coverage: true,
      priceEqualsPreview: true,
      failures: [],
    });
    expect(hardMetricsPassed([metrics])).toBe(true);
  });

  it("fails a changed timing line", () => {
    const damaged = good.replace("00:00:04,000", "00:00:04,001");
    const metrics = measure(damaged);
    expect(metrics.hard.structuralFidelity).toBe(false);
    expect(metrics.hard.failures.join(" ")).toContain("index or timing line");
  });

  it("fails a lost tag", () => {
    const metrics = measure(good.replace("<i>Hallo.</i>", "Hallo."));
    expect(metrics.hard.tagPreservation).toBe(false);
  });

  it("fails a lost cue", () => {
    const metrics = measure(
      ["1", "00:00:01,000 --> 00:00:03,000", "<i>Hallo.</i>", "", ""].join("\n"),
    );
    expect(metrics.hard.coverage).toBe(false);
    expect(hardMetricsPassed([metrics])).toBe(false);
  });

  it("fails when the price charged is not the price previewed", () => {
    const metrics = measure(good, { priceCents: 999 });
    expect(metrics.hard.priceEqualsPreview).toBe(false);
    expect(metrics.hard.failures.join(" ")).toContain("not the price previewed");
  });

  it("reports the advisory metrics per thousand cues", () => {
    const metrics = measure(good, {
      readingSpeedFindings: [{ id: 1, timing: "x", charsPerSecond: 30 }],
    });
    expect(metrics.advisory.readingSpeedFlagsPerThousandCues).toBe(500);
    expect(metrics.advisory.cacheReadShare).toBe(0.7);
  });
});

describe("the judge", () => {
  it("samples cues spread through the file, not clustered", () => {
    const ids = Array.from({ length: 100 }, (_unused, index) => index + 1);
    const sample = stratifiedSample(ids, 5);
    expect(sample).toEqual([1, 21, 41, 61, 81]);
    expect(stratifiedSample(ids, 200)).toHaveLength(100);
    expect(stratifiedSample(ids, 0)).toEqual([]);
  });

  it("shows the judge the whole file but asks it to score only the sample", () => {
    const source = parseSubtitleText(
      [
        "1",
        "00:00:01,000 --> 00:00:02,000",
        "One.",
        "",
        "2",
        "00:00:03,000 --> 00:00:04,000",
        "Two.",
        "",
        "",
      ].join("\n"),
    );
    const rendered = renderJudgeRequest(
      { source, output: source, targetLanguage: "German", glossary: "Glossary:" },
      [1],
    );
    expect(rendered).toContain("1\tOne.\tOne.");
    expect(rendered).toContain("context\tTwo.\tTwo.");
  });

  it("averages the sample and lists the lowest scores", async () => {
    const source = parseSubtitleText(
      [
        "1",
        "00:00:01,000 --> 00:00:02,000",
        "One.",
        "",
        "2",
        "00:00:03,000 --> 00:00:04,000",
        "Two.",
        "",
        "",
      ].join("\n"),
    );
    const client = new FakeJudgeModelClient({ score: 3 });
    const result = await judgeFile(
      client,
      { source, output: source, targetLanguage: "German", glossary: "Glossary:", jobId: "j" },
      { sampleSize: 2 },
    );
    expect(result.rubricVersion).toBe(RUBRIC_VERSION);
    expect(result.means?.accuracy).toBe(3);
    expect(result.lowest).toHaveLength(8);
    expect(result.sampledCues).toBe(2);
  });

  it("has a rubric that defines all four axes from 1 to 5", () => {
    for (const axis of ["ACCURACY", "NATURALNESS", "REGISTER", "NAME CONSISTENCY"]) {
      expect(JUDGE_RUBRIC).toContain(axis);
    }
    expect(JUDGE_RUBRIC).toContain("read in under three\nseconds");
  });

  it("checks name renderings across episodes without a model", () => {
    const episodes = [
      { file: "e1", text: "Marta and Ivo" },
      { file: "e2", text: "Marta and Ivo and Petar" },
      { file: "e3", text: "Marta and Ivo and Petar" },
    ];
    expect(checkNameConsistency(episodes, ["Marta", "Ivo"]).consistent).toBe(true);
    const uneven = checkNameConsistency(episodes, ["Petar"]);
    expect(uneven.consistent).toBe(false);
    expect(uneven.findings[0]).toContain("e2, e3");
  });
});

describe("the runner", () => {
  it("runs the whole corpus end to end with the fake client", async () => {
    const result = await runEval({
      client: new FakeJudgeModelClient(),
      targets: ["de"],
      lane: "fast",
      config: { batchSize: 20 },
      judgeSampleSize: 4,
    });

    expect(result.hardMetricsPassed).toBe(true);
    expect(result.files).toHaveLength(loadCorpus().length);
    expect(result.totals.cues).toBeGreaterThan(300);
    expect(result.seasons).toHaveLength(1);
    expect(result.seasons[0]?.consistent).toBe(true);
    expect(result.promptVersion).toMatch(/@v3$/);
    expect(result.rubricVersion).toBe(RUBRIC_VERSION);
    for (const file of result.files) expect(file.judge?.means?.accuracy).toBe(4);
  });

  it("runs the economy lane end to end", async () => {
    const result = await runEval({
      client: new FakeJudgeModelClient(),
      targets: ["de"],
      lane: "economy",
      config: { batchSize: 20 },
      judge: false,
      only: "comedy/",
    });
    expect(result.hardMetricsPassed).toBe(true);
    expect(result.files[0]?.judge).toBeNull();
    expect(result.files[0]?.metrics.lane).toBe("economy");
  });

  it("writes a results folder with the machine and human readable files", async () => {
    const result = await runEval({
      client: new FakeJudgeModelClient(),
      targets: ["de"],
      lane: "fast",
      judge: false,
      only: "documentary/",
    });
    const written = writeResults(result, { root: directory, label: "test" });
    expect(readdirSync(written).sort()).toEqual(["result.json", "summary.md"]);
    const parsed: unknown = JSON.parse(readFileSync(join(written, "result.json"), "utf8"));
    expect(parsed).toMatchObject({ hardMetricsPassed: true });
    expect(readFileSync(join(written, "summary.md"), "utf8")).toContain("Hard metrics: all passed");
  });

  it("marks a hard-metric failure loudly in the summary", () => {
    const summary = summarise({
      startedAt: "2026-09-09T00:00:00.000Z",
      promptVersion: "v3",
      rubricVersion: RUBRIC_VERSION,
      model: "fake",
      effort: "medium",
      lane: "fast",
      targets: ["de"],
      files: [
        {
          metrics: {
            file: "a.srt",
            target: "de",
            lane: "fast",
            hard: {
              structuralFidelity: false,
              tagPreservation: true,
              coverage: true,
              priceEqualsPreview: true,
              failures: ["cue 4 lost its index or timing line"],
            },
            advisory: {
              cues: 1,
              dialogueChars: 1,
              untranslatedCues: 0,
              readingSpeedFlagsPerThousandCues: 0,
              longLineFlagsPerThousandCues: 0,
              repairs: 0,
              wallTimeMs: 1,
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreation5mInputTokens: 0,
                cacheCreation1hInputTokens: 0,
              },
              modelCostUsd: 0,
              priceCents: 10,
              cacheReadShare: 0,
            },
          },
          judge: null,
        },
      ],
      seasons: [],
      hardMetricsPassed: false,
      totals: {
        files: 1,
        cues: 1,
        dialogueChars: 1,
        priceCents: 10,
        modelCostUsd: 0,
        wallTimeMs: 1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreation5mInputTokens: 0,
          cacheCreation1hInputTokens: 0,
        },
      },
    });
    expect(summary).toContain("Hard metrics: FAILED");
    expect(summary).toContain("**FAIL**");
    expect(summary).toContain("cue 4 lost its index or timing line");
  });
});
