import { priceCents } from "@lexicue/pricing";
import { parseSubtitleText, serialiseSubtitleDocument } from "@lexicue/subtitles";
import { describe, expect, it } from "vitest";
import { collectEconomyBatch, planBatches, submitEconomyBatch } from "./batches.js";
import { FakeTranslationModelClient } from "./clients/fake.js";
import { FaultInjectingModelClient } from "./clients/fault.js";
import { DEFAULT_HARNESS_CONFIG, resolveConfig, type HarnessConfig } from "./config.js";
import { costBreakdown, modelCostUsd } from "./cost.js";
import { findTargetLanguage } from "./languages.js";
import { emptyUsage, type TranslationModelClient } from "./model-client.js";
import { reassembleDocument } from "./reassemble.js";
import { emptyGlossary } from "./schemas.js";
import { translateFile } from "./translate-file.js";
import { toProtocolCue, type TranslationJob, type TranslationOptions } from "./types.js";

const FILM = [
  "1",
  "00:00:01,000 --> 00:00:02,000",
  "The lighthouse at Skerry Point has been dark for a week.",
  "",
  "2",
  "00:00:03,400 --> 00:00:06,120 X1:100 X2:620 Y1:420 Y2:480",
  "- And nobody thought to call?",
  "- <i>We called.</i>",
  "",
  "3",
  "00:00:06,300 --> 00:00:08,000",
  "{\\an8}TWELVE YEARS EARLIER",
  "",
  "4",
  "00:00:08,200 --> 00:00:20,000",
  "Then we row out at first light.",
  "",
  "",
].join("\n");

function options(overrides: Partial<TranslationOptions> = {}): TranslationOptions {
  const target = findTargetLanguage(overrides.target?.code ?? "de");
  if (target === undefined) throw new Error("unknown target");
  return {
    target,
    lane: "fast",
    formality: "auto",
    contextNote: "",
    lineHandling: "reflow",
    translateLyrics: true,
    ...overrides,
  };
}

function job(text = FILM, fileName = "the-keeper.srt"): TranslationJob {
  return { jobId: "job-1", fileName, document: parseSubtitleText(text) };
}

function config(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return resolveConfig({ batchSize: 2, concurrency: 2, ...overrides });
}

let clock = 0;
const now = (): number => {
  clock += 500;
  return clock;
};

describe("the structural guarantees of spec section 4.1", () => {
  it("returns the same number of cues in the same order", async () => {
    const source = job();
    const result = await translateFile({
      client: new FakeTranslationModelClient(),
      config: config(),
      options: options(),
      job: source,
      now,
    });
    expect(result.document.cues).toHaveLength(source.document.cues.length);
    expect(result.document.cues.map((cue) => cue.id)).toEqual([1, 2, 3, 4]);
  });

  it("copies every index line and timing line verbatim, position hints included", async () => {
    const source = job();
    const result = await translateFile({
      client: new FakeTranslationModelClient(),
      config: config(),
      options: options(),
      job: source,
      now,
    });
    expect(result.document.cues.map((cue) => cue.rawIndexLine)).toEqual(
      source.document.cues.map((cue) => cue.rawIndexLine),
    );
    expect(result.document.cues.map((cue) => cue.rawTimingLine)).toEqual(
      source.document.cues.map((cue) => cue.rawTimingLine),
    );
    expect(result.text).toContain("00:00:03,400 --> 00:00:06,120 X1:100 X2:620 Y1:420 Y2:480");
  });

  it("keeps inline tags and re-attaches the positioning override", async () => {
    const result = await translateFile({
      client: new FakeTranslationModelClient(),
      config: config(),
      options: options(),
      job: job(),
      now,
    });
    expect(result.document.cues[1]?.lines[1]).toBe("- <i>«We called.»</i>");
    expect(result.text).toContain("{\\an8}«TWELVE YEARS EARLIER»");
  });

  it("re-parses its own output and finds the same structure", async () => {
    const source = job();
    const result = await translateFile({
      client: new FakeTranslationModelClient(),
      config: config(),
      options: options(),
      job: source,
      now,
    });
    const reparsed = parseSubtitleText(result.text);
    expect(reparsed.cues.map((cue) => cue.rawTimingLine)).toEqual(
      source.document.cues.map((cue) => cue.rawTimingLine),
    );
    expect(serialiseSubtitleDocument(reparsed)).toBe(result.text);
  });

  it("leaves a cue it could not translate in the source language and lists it", async () => {
    // The model empties cue 1 on every attempt: the first answer and both retries.
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [
        null, // the glossary pass
        { kind: "empty", ids: [1] },
        { kind: "empty", ids: [1] },
        { kind: "empty", ids: [1] },
      ],
    });
    const result = await translateFile({
      client,
      config: config({ batchSize: 4 }),
      options: options(),
      job: job(),
      now,
    });
    expect(result.report.untranslatedCues).toHaveLength(1);
    expect(result.report.untranslatedCues[0]?.id).toBe(1);
    expect(result.report.untranslatedCues[0]?.timing).toBe("00:00:01,000 --> 00:00:02,000");
    expect(result.document.cues[0]?.lines).toEqual([
      "The lighthouse at Skerry Point has been dark for a week.",
    ]);
    expect(result.report.translatedCues).toBe(3);
  });
});

describe("retries", () => {
  it("retries a failing cue and accepts the second answer", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [null, { kind: "drop-ids", ids: [1] }],
    });
    const result = await translateFile({
      client,
      config: config(),
      options: options(),
      job: job(),
      now,
    });
    expect(result.report.untranslatedCues).toEqual([]);
    expect(result.document.cues[0]?.lines[0]).toBe(
      "«The lighthouse at Skerry Point has been dark for a week.»",
    );
  });

  it("gives a cue exactly two retries and no more", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [
        null,
        { kind: "drop-ids", ids: [1] },
        { kind: "drop-ids", ids: [1] },
        { kind: "drop-ids", ids: [1] },
        { kind: "drop-ids", ids: [1] },
      ],
    });
    const before = client.calls;
    const result = await translateFile({
      client,
      config: config({ batchSize: 4 }),
      options: options(),
      job: job(),
      now,
    });
    // One glossary pass, one batch, two retries.
    expect(client.calls - before).toBe(4);
    expect(result.report.untranslatedCues.map((cue) => cue.id)).toEqual([1]);
  });

  it("re-runs a max_tokens batch as two half batches", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [null, { kind: "stop", reason: "max_tokens" }],
    });
    const result = await translateFile({
      client,
      config: config({ batchSize: 4 }),
      options: options(),
      job: job(),
      now,
    });
    expect(result.report.warnings.some((w) => w.includes("re-run as two half batches"))).toBe(true);
    expect(result.report.untranslatedCues).toEqual([]);
    expect(result.report.batches).toBe(2);
  });

  it("retries a refusal on the fallback model and completes", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [null, { kind: "stop", reason: "refusal", category: "cyber" }],
    });
    const result = await translateFile({
      client,
      config: config({ batchSize: 4 }),
      options: options(),
      job: job(),
      now,
    });
    expect(result.report.fallbackModelUsed).toBe(true);
    expect(result.report.warnings.some((w) => w.includes("claude-opus-5"))).toBe(true);
    expect(result.report.untranslatedCues).toEqual([]);
  });

  it("flags the cues when the fallback model refuses too", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [
        null,
        { kind: "stop", reason: "refusal", category: "cyber" },
        { kind: "stop", reason: "refusal", category: "cyber" },
        { kind: "unparseable" },
        { kind: "unparseable" },
      ],
    });
    const result = await translateFile({
      client,
      config: config({ batchSize: 4 }),
      options: options(),
      job: job(),
      now,
    });
    expect(result.report.warnings.some((w) => w.includes("refused by the fallback model"))).toBe(
      true,
    );
    expect(result.report.untranslatedCues).toHaveLength(4);
    // The file still completes: every cue keeps its source text.
    expect(result.text).toContain("The lighthouse at Skerry Point has been dark for a week.");
  });

  it("keeps every cue when a whole batch fails at the transport level", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [
        null,
        { kind: "http", status: 500 },
        { kind: "http", status: 500 },
        { kind: "http", status: 500 },
        { kind: "http", status: 500 },
        { kind: "http", status: 500 },
        { kind: "http", status: 500 },
        { kind: "http", status: 500 },
        { kind: "http", status: 500 },
        { kind: "http", status: 500 },
      ],
    });
    const result = await translateFile({
      client,
      config: config({ batchSize: 4, transportRetries: 1 }),
      options: options(),
      job: job(),
      now,
    });
    expect(result.report.untranslatedCues).toHaveLength(4);
    expect(result.report.untranslatedCues[0]?.reason).toMatch(/500/);
  });
});

describe("the report of spec section 3.5", () => {
  it("counts cues, prices the file and records the model and prompt version", async () => {
    const source = job();
    const result = await translateFile({
      client: new FakeTranslationModelClient(),
      config: config(),
      options: options(),
      job: source,
      now,
    });
    const report = result.report;
    expect(report.file).toBe("the-keeper.srt");
    expect(report.totalCues).toBe(4);
    expect(report.translatedCues).toBe(4);
    expect(report.lane).toBe("fast");
    expect(report.model).toBe("claude-sonnet-5");
    expect(report.effort).toBe("medium");
    expect(report.promptVersion).toMatch(/@v3$/);
    expect(report.dialogueChars).toBe(source.document.dialogueChars);
    expect(report.priceCents).toBe(priceCents(source.document.dialogueChars, "fast"));
    expect(report.wallTimeMs).toBeGreaterThan(0);
  });

  it("flags cues that read too fast at 20 characters a second", async () => {
    const result = await translateFile({
      client: new FakeTranslationModelClient(),
      config: config(),
      options: options(),
      job: job(),
      now,
    });
    // Cue 1 is 58 characters in one second; cue 4 is 32 in 11.8 seconds.
    const flagged = result.report.readingSpeedFindings.map((finding) => finding.id);
    expect(flagged).toContain(1);
    expect(flagged).not.toContain(4);
  });

  it("flags lines over 42 characters for a Latin target and not for a CJK one", async () => {
    const latin = await translateFile({
      client: new FakeTranslationModelClient(),
      config: config(),
      options: options(),
      job: job(),
      now,
    });
    expect(latin.report.longLines.length).toBeGreaterThan(0);
    expect(latin.report.longLines[0]?.length).toBeGreaterThan(42);

    const japanese = findTargetLanguage("ja");
    if (japanese === undefined) throw new Error("ja missing");
    const cjk = await translateFile({
      client: new FakeTranslationModelClient(),
      config: config(),
      options: options({ target: japanese }),
      job: job(),
      now,
    });
    expect(cjk.report.longLines).toEqual([]);
  });

  it("sums the usage and prices it with the table in spec section 5.1", async () => {
    const result = await translateFile({
      client: new FakeTranslationModelClient(),
      config: config(),
      options: options(),
      job: job(),
      now,
    });
    expect(result.report.usage.outputTokens).toBeGreaterThan(0);
    expect(result.report.modelCostUsd).toBeCloseTo(
      modelCostUsd(result.report.usage, "claude-sonnet-5", "fast"),
      12,
    );
    expect(result.report.cost.totalUsd).toBeCloseTo(result.report.modelCostUsd, 12);
  });

  it("counts the glossary entries the batches were given", async () => {
    const client = new FakeTranslationModelClient({
      glossaryCharacters: [{ name: "Marta", rendered: "Marta", notes: "" }],
      glossaryTerms: [{ source: "the Light", target: "das Licht", notes: "" }],
    });
    const result = await translateFile({
      client,
      config: config(),
      options: options(),
      job: job(),
      now,
    });
    expect(result.report.glossaryEntriesApplied).toBe(2);
  });

  it("warns when the batches read nothing from the prompt cache", async () => {
    // A client that reports no cache reads is exactly the symptom spec section
    // 4.8 says to watch for: the prefix was silently changed.
    const client = new FakeTranslationModelClient();
    const wrapped: TranslationModelClient = {
      name: "no-cache",
      retriesTransportErrors: false,
      async complete(request) {
        const response = await client.complete(request);
        return { ...response, usage: { ...response.usage, cacheReadInputTokens: 0 } };
      },
      countTokens: (request) => client.countTokens(request),
    };
    const result = await translateFile({
      client: wrapped,
      config: config(),
      options: options(),
      job: job(),
      now,
    });
    expect(result.report.warnings.some((w) => w.includes("prompt cache"))).toBe(true);
  });
});

describe("the economy lane", () => {
  it("produces the same file as the fast lane from a Message Batch", async () => {
    const client = new FakeTranslationModelClient();
    const source = job();
    const fast = await translateFile({
      client: new FakeTranslationModelClient(),
      config: config(),
      options: options(),
      job: source,
      now,
    });

    const economyOptions = options({ lane: "economy" });
    const cues = source.document.cues.map(toProtocolCue);
    const plan = planBatches(source.jobId, cues, 2);
    const context = {
      config: config(),
      options: economyOptions,
      jobId: source.jobId,
      sourceDocument: "",
    };
    const { batchId } = await submitEconomyBatch(client, [
      { context, glossary: emptyGlossary(), plan },
    ]);
    const collected = await collectEconomyBatch(
      client,
      batchId,
      new Map(plan.map((entry) => [entry.customId, entry])),
      DEFAULT_HARNESS_CONFIG,
    );

    const economy = await translateFile({
      client,
      config: config(),
      options: economyOptions,
      job: source,
      glossary: emptyGlossary(),
      collected,
      now,
    });

    expect(economy.text).toBe(fast.text);
    expect(economy.report.lane).toBe("economy");
    expect(economy.report.priceCents).toBe(priceCents(source.document.dialogueChars, "economy"));
  });

  it("retries an errored Message Batch entry interactively", async () => {
    const client = new FakeTranslationModelClient();
    const source = job();
    const cues = source.document.cues.map(toProtocolCue);
    const plan = planBatches(source.jobId, cues, 2);
    const context = {
      config: config(),
      options: options({ lane: "economy" }),
      jobId: source.jobId,
      sourceDocument: "",
    };
    const { batchId } = await submitEconomyBatch(client, [
      { context, glossary: emptyGlossary(), plan },
    ]);
    const collected = await collectEconomyBatch(
      client,
      batchId,
      new Map(plan.map((entry) => [entry.customId, entry])),
      DEFAULT_HARNESS_CONFIG,
    );
    collected.set("job-1:1", {
      index: 1,
      customId: "job-1:1",
      requestedIds: [3, 4],
      answers: [],
      stopReason: "other",
      refusalCategory: null,
      usage: emptyUsage(),
      error: "The request failed inside the Message Batch.",
    });

    const result = await translateFile({
      client,
      config: config(),
      options: options({ lane: "economy" }),
      job: source,
      glossary: emptyGlossary(),
      collected,
      now,
    });
    expect(result.report.untranslatedCues).toEqual([]);
    expect(result.document.cues[3]?.lines[0]).toBe("«Then we row out at first light.»");
  });
});

describe("reassembly", () => {
  it("changes nothing but the lines", () => {
    const source = parseSubtitleText(FILM);
    const output = reassembleDocument(source, new Map([[1, ["Neuer Text."]]]));
    expect(output.cues[0]?.lines).toEqual(["Neuer Text."]);
    expect(output.cues[0]?.rawTimingLine).toBe(source.cues[0]?.rawTimingLine);
    expect(output.cues[1]).toBe(source.cues[1]);
    expect(output.eol).toBe(source.eol);
  });

  it("keeps one protected-code slot per line when the line count changed", () => {
    const source = parseSubtitleText(FILM);
    const output = reassembleDocument(source, new Map([[3, ["Zeile eins.", "Zeile zwei."]]]));
    expect(output.cues[2]?.linePrefixCodes).toEqual(["{\\an8}", ""]);
  });

  it("never loses a control code when the translation has fewer lines", () => {
    const source = parseSubtitleText(
      ["1", "00:00:01,000 --> 00:00:02,000", "{y:i}A", "{c:$00ff00}B", "", ""].join("\n"),
    );
    const output = reassembleDocument(source, new Map([[1, ["Eine Zeile."]]]));
    expect(output.cues[0]?.linePrefixCodes.join("")).toBe(source.cues[0]?.linePrefixCodes.join(""));
  });

  it("recomputes the billable characters of the output", () => {
    const source = parseSubtitleText(FILM);
    const output = reassembleDocument(source, new Map([[1, ["Kurz."]]]));
    expect(output.dialogueChars).toBeLessThan(source.dialogueChars);
  });
});

describe("the cost model", () => {
  it("prices a feature film's usage with the table in spec section 5.4", () => {
    // The worked example: 24,700 cache write, 296,400 cache reads,
    // 28,800 uncached input and 57,000 output tokens is $0.75 on Sonnet 5.
    const usage = {
      inputTokens: 28_800,
      outputTokens: 57_000,
      cacheCreationInputTokens: 24_700,
      cacheReadInputTokens: 296_400,
      cacheCreation5mInputTokens: 24_700,
      cacheCreation1hInputTokens: 0,
    };
    const breakdown = costBreakdown(usage, "claude-sonnet-5", "fast");
    expect(breakdown.cacheWriteUsd).toBeCloseTo(0.0618, 3);
    expect(breakdown.cacheReadUsd).toBeCloseTo(0.0593, 3);
    expect(breakdown.uncachedInputUsd).toBeCloseTo(0.0576, 3);
    expect(breakdown.outputUsd).toBeCloseTo(0.57, 2);
    expect(breakdown.totalUsd).toBeCloseTo(0.75, 2);
  });

  it("halves every price on the Message Batches API", () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 1000,
      cacheCreation5mInputTokens: 1000,
      cacheCreation1hInputTokens: 0,
    };
    expect(modelCostUsd(usage, "claude-sonnet-5", "economy")).toBeCloseTo(
      modelCostUsd(usage, "claude-sonnet-5", "fast") / 2,
      12,
    );
  });

  it("charges the one-hour write at twice the base input rate", () => {
    const hourly = modelCostUsd(
      {
        ...emptyUsage(),
        cacheCreationInputTokens: 1_000_000,
        cacheCreation1hInputTokens: 1_000_000,
      },
      "claude-sonnet-5",
      "fast",
    );
    expect(hourly).toBeCloseTo(4, 10);
  });

  it("falls back to the Sonnet 5 rate card for an unknown model", () => {
    const usage = { ...emptyUsage(), outputTokens: 1_000_000 };
    expect(modelCostUsd(usage, "claude-something-new", "fast")).toBeCloseTo(10, 10);
  });
});
