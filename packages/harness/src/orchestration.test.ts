import { parseSubtitleText } from "@subtitle-translator/subtitles";
import { describe, expect, it } from "vitest";
import {
  collectEconomyBatch,
  parseCustomId,
  planBatches,
  runFastLaneBatches,
  submitEconomyBatch,
  type BatchPlanEntry,
} from "./batches.js";
import { FakeTranslationModelClient } from "./clients/fake.js";
import { FaultInjectingModelClient } from "./clients/fault.js";
import { mapWithConcurrency } from "./concurrency.js";
import { DEFAULT_HARNESS_CONFIG, resolveConfig } from "./config.js";
import { BatchNeverEndedError, ModelTransportError } from "./errors.js";
import { findContradictions, mergeGlossaries, runGlossaryPass } from "./glossary.js";
import { findTargetLanguage } from "./languages.js";
import type { ModelRequest, ModelResponse, TranslationModelClient } from "./model-client.js";
import { emptyUsage } from "./model-client.js";
import { buildSourceDocument, type RequestContext } from "./requests.js";
import { buildSeasonSample, runSeasonGlossaryPass } from "./season.js";
import { emptyGlossary, type FileGlossary, type SeasonGlossary } from "./schemas.js";
import { withTransportRetry } from "./transport.js";
import { toProtocolCue, type TranslationJob, type TranslationOptions } from "./types.js";

function makeSrt(count: number, prefix = "Line"): string {
  const blocks: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const seconds = i % 60;
    const minutes = Math.floor(i / 60) % 60;
    const stamp = `00:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    blocks.push(`${i.toString()}\n${stamp},000 --> ${stamp},900\n${prefix} ${i.toString()}.\n`);
  }
  return blocks.join("\n") + "\n";
}

function job(fileName: string, cues: number, prefix?: string): TranslationJob {
  return {
    jobId: fileName.replace(/\W/g, "-"),
    fileName,
    document: parseSubtitleText(makeSrt(cues, prefix)),
  };
}

function context(target = "de", overrides: Partial<TranslationOptions> = {}): RequestContext {
  const language = findTargetLanguage(target);
  if (language === undefined) throw new Error(`unknown target ${target}`);
  const options: TranslationOptions = {
    target: language,
    lane: "fast",
    formality: "auto",
    contextNote: "",
    lineHandling: "reflow",
    translateLyrics: true,
    ...overrides,
  };
  return {
    config: DEFAULT_HARNESS_CONFIG,
    options,
    jobId: "job-1",
    sourceDocument: "",
  };
}

describe("mapWithConcurrency", () => {
  it("keeps the order of the results", async () => {
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, (n) => Promise.resolve(n * 2));
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 40 }, (_unused, i) => i),
      12,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await Promise.resolve();
        await Promise.resolve();
        running -= 1;
        return null;
      },
    );
    expect(peak).toBeLessThanOrEqual(12);
    expect(peak).toBeGreaterThan(1);
  });

  it("refuses a limit below one", async () => {
    await expect(mapWithConcurrency([1], 0, () => Promise.resolve(1))).rejects.toThrow(RangeError);
  });
});

describe("planBatches", () => {
  it("groups cues into batches of the configured size", () => {
    const cues = Array.from({ length: 250 }, (_unused, i) => ({ id: i + 1, lines: ["x"] }));
    const plan = planBatches("job-9", cues, 120);
    expect(plan.map((entry) => entry.cues.length)).toEqual([120, 120, 10]);
    expect(plan.map((entry) => entry.customId)).toEqual(["job-9:0", "job-9:1", "job-9:2"]);
  });

  it("uses the custom id format the Message Batches API is keyed by", () => {
    expect(parseCustomId("job-9:2")).toEqual({ jobId: "job-9", batchIndex: 2 });
    expect(parseCustomId("a:b:7")).toEqual({ jobId: "a:b", batchIndex: 7 });
    expect(parseCustomId("no-index")).toBeNull();
    expect(parseCustomId("job:-1")).toBeNull();
  });

  it("refuses a batch size below one", () => {
    expect(() => planBatches("j", [], 0)).toThrow(RangeError);
  });
});

describe("the fast lane", () => {
  it("translates every batch of a file and reports the ids it asked for", async () => {
    const client = new FakeTranslationModelClient();
    const document = parseSubtitleText(makeSrt(250));
    const cues = document.cues.map(toProtocolCue);
    const ctx = { ...context(), sourceDocument: buildSourceDocument(cues) };
    const plan = planBatches("job-1", cues, 120);

    const results = await runFastLaneBatches(client, ctx, plan, emptyGlossary());

    expect(results).toHaveLength(3);
    expect(results.flatMap((result) => result.answers.map((answer) => answer.i))).toHaveLength(250);
    expect(results[0]?.answers[0]?.t).toBe("«Line 1.»");
  });

  it("records a batch that failed at the transport level instead of throwing", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [
        { kind: "http", status: 500 },
        { kind: "http", status: 500 },
        { kind: "http", status: 500 },
      ],
    });
    const document = parseSubtitleText(makeSrt(3));
    const cues = document.cues.map(toProtocolCue);
    const ctx = {
      ...context(),
      config: resolveConfig({ transportRetries: 2 }),
      sourceDocument: buildSourceDocument(cues),
    };
    const results = await runFastLaneBatches(
      client,
      ctx,
      planBatches("job-1", cues, 120),
      emptyGlossary(),
    );
    expect(results[0]?.error).toMatch(/500/);
    expect(results[0]?.answers).toEqual([]);
  });
});

describe("transport retries", () => {
  const failing = (failures: number): TranslationModelClient => {
    let calls = 0;
    return {
      name: "flaky",
      retriesTransportErrors: false,
      complete<T>(): Promise<ModelResponse<T>> {
        calls += 1;
        if (calls <= failures) {
          return Promise.reject(new ModelTransportError("429 too many requests", { status: 429 }));
        }
        return Promise.resolve({
          parsed: null,
          stopReason: "end_turn",
          refusalCategory: null,
          usage: emptyUsage(),
          model: "flaky",
        });
      },
      countTokens: () => Promise.resolve(0),
    };
  };

  it("retries a 429 up to the configured number of times", async () => {
    const client = failing(2);
    const response = await withTransportRetry(client, { transportRetries: 2 }, () =>
      client.complete({} as ModelRequest<unknown>),
    );
    expect(response.stopReason).toBe("end_turn");
  });

  it("gives up once the retries are used", async () => {
    const client = failing(5);
    await expect(
      withTransportRetry(client, { transportRetries: 2 }, () =>
        client.complete({} as ModelRequest<unknown>),
      ),
    ).rejects.toThrow(ModelTransportError);
  });

  it("adds no retries of its own for a client that already retries", async () => {
    const client = { ...failing(1), retriesTransportErrors: true };
    await expect(
      withTransportRetry(client, { transportRetries: 2 }, () =>
        client.complete({} as ModelRequest<unknown>),
      ),
    ).rejects.toThrow(ModelTransportError);
  });

  it("does not retry an error that is not a transport error", async () => {
    let calls = 0;
    const client = { ...failing(0), retriesTransportErrors: false };
    await expect(
      withTransportRetry(client, { transportRetries: 3 }, () => {
        calls += 1;
        throw new Error("a bug, not a 429");
      }),
    ).rejects.toThrow("a bug, not a 429");
    expect(calls).toBe(1);
  });
});

describe("the season glossary", () => {
  const jobs = [job("s01e01.srt", 200), job("s01e02.srt", 200), job("s01e03.srt", 200)];

  it("samples the first 150 cues of every file", async () => {
    const client = new FakeTranslationModelClient();
    const sample = await buildSeasonSample(client, DEFAULT_HARNESS_CONFIG, jobs);
    expect(sample.includedFiles).toEqual(["s01e01.srt", "s01e02.srt", "s01e03.srt"]);
    expect(sample.droppedFiles).toEqual([]);
    expect(sample.text).toContain("## s01e01.srt");
    expect(sample.text).toContain("150\tLine 150.");
    expect(sample.text).not.toContain("151\tLine 151.");
  });

  it("stops adding files once the token cap is reached", async () => {
    const client = new FakeTranslationModelClient();
    const sample = await buildSeasonSample(
      client,
      resolveConfig({ seasonSampleTokenCap: 900 }),
      jobs,
    );
    expect(sample.includedFiles.length).toBeLessThan(3);
    expect(sample.droppedFiles.length).toBeGreaterThan(0);
    expect(sample.tokens).toBeLessThanOrEqual(900 + 1);
  });

  it("always includes the first file, however small the cap", async () => {
    const client = new FakeTranslationModelClient();
    const sample = await buildSeasonSample(
      client,
      resolveConfig({ seasonSampleTokenCap: 1 }),
      jobs,
    );
    expect(sample.includedFiles).toEqual(["s01e01.srt"]);
  });

  it("returns the shared style sheet", async () => {
    const client = new FakeTranslationModelClient({
      glossaryCharacters: [{ name: "Marta", rendered: "Marta", notes: "the keeper" }],
    });
    const result = await runSeasonGlossaryPass(client, context(), jobs);
    expect(result.glossary?.characters[0]?.name).toBe("Marta");
    expect(result.sample.includedFiles).toHaveLength(3);
  });
});

describe("merging a file glossary into the season's", () => {
  const season: SeasonGlossary = {
    sourceLanguage: "English",
    register: "informal",
    characters: [{ name: "Marta", rendered: "Marta", notes: "the keeper" }],
    terms: [{ source: "the Light", target: "das Licht", notes: "" }],
    styleNotes: ["Marta always understates the weather"],
  };

  const file: FileGlossary = {
    sourceLanguage: "English",
    register: "formal",
    characters: [
      { name: "marta", rendered: "Martha", notes: "" },
      { name: "Ivo", rendered: "Ivo", notes: "the new deckhand" },
    ],
    terms: [
      { source: "the light", target: "der Leuchtturm", notes: "" },
      { source: "the tender", target: "das Versorgungsboot", notes: "" },
    ],
    styleNotes: ["Ivo speaks in short sentences"],
  };

  it("lets a later episode add a character the season did not have", () => {
    const merged = mergeGlossaries(season, file);
    expect(merged.characters.map((entry) => entry.name)).toEqual(["Marta", "Ivo"]);
    expect(merged.terms.map((entry) => entry.source)).toEqual(["the Light", "the tender"]);
  });

  it("never lets a file change what the season fixed", () => {
    const merged = mergeGlossaries(season, file);
    expect(merged.characters[0]?.rendered).toBe("Marta");
    expect(merged.terms[0]?.target).toBe("das Licht");
    expect(merged.register).toBe("informal");
  });

  it("keeps the season's style notes and adds the file's", () => {
    const merged = mergeGlossaries(season, file);
    expect(merged.styleNotes).toEqual([
      "Marta always understates the weather",
      "Ivo speaks in short sentences",
    ]);
  });

  it("passes a file glossary straight through when there is no season", () => {
    expect(mergeGlossaries(null, file)).toBe(file);
  });

  it("names the contradictions it silently overrode", () => {
    const problems = findContradictions(season, file);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("Martha");
    expect(problems[1]).toContain("der Leuchtturm");
    expect(problems[2]).toContain("register");
  });

  it("finds nothing to complain about when the file agrees", () => {
    expect(findContradictions(season, { ...season })).toEqual([]);
  });
});

describe("the file glossary pass", () => {
  it("merges the season glossary in before the batches ever see it", async () => {
    const client = new FakeTranslationModelClient({
      glossaryCharacters: [{ name: "Marta", rendered: "Martha", notes: "" }],
    });
    const season: SeasonGlossary = {
      sourceLanguage: "English",
      register: "informal",
      characters: [{ name: "Marta", rendered: "Marta", notes: "the keeper" }],
      terms: [],
      styleNotes: [],
    };
    const result = await runGlossaryPass(client, context(), season);
    expect(result.degraded).toBe(false);
    expect(result.glossary.characters[0]?.rendered).toBe("Marta");
  });

  it("completes with an empty glossary when the model gives nothing usable", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [{ kind: "unparseable" }],
    });
    const result = await runGlossaryPass(client, context(), null);
    expect(result.degraded).toBe(true);
    expect(result.glossary.characters).toEqual([]);
  });
});

describe("the economy lane", () => {
  function planFor(jobId: string, cues: number, batchSize: number): BatchPlanEntry[] {
    return planBatches(jobId, parseSubtitleText(makeSrt(cues)).cues.map(toProtocolCue), batchSize);
  }

  it("puts every file's batches into one Message Batch with the spec's custom ids", async () => {
    const client = new FakeTranslationModelClient();
    const first = planFor("ep1", 10, 4);
    const second = planFor("ep2", 5, 4);
    const { batchId, requests } = await submitEconomyBatch(client, [
      { context: context("bg", { lane: "economy" }), glossary: emptyGlossary(), plan: first },
      { context: context("bg", { lane: "economy" }), glossary: emptyGlossary(), plan: second },
    ]);
    expect(batchId).toMatch(/^msgbatch_fake_/);
    expect(requests.map((request) => request.customId)).toEqual([
      "ep1:0",
      "ep1:1",
      "ep1:2",
      "ep2:0",
      "ep2:1",
    ]);
  });

  it("keys results by custom id even though they arrive in any order", async () => {
    const client = new FakeTranslationModelClient();
    const plan = planFor("ep1", 10, 4);
    const { batchId } = await submitEconomyBatch(client, [
      { context: context("de", { lane: "economy" }), glossary: emptyGlossary(), plan },
    ]);
    const byId = new Map(plan.map((entry) => [entry.customId, entry]));
    const collected = await collectEconomyBatch(client, batchId, byId, DEFAULT_HARNESS_CONFIG);
    expect([...collected.keys()].sort()).toEqual(["ep1:0", "ep1:1", "ep1:2"]);
    expect(collected.get("ep1:0")?.answers).toHaveLength(4);
    expect(collected.get("ep1:2")?.answers).toHaveLength(2);
  });

  it("records errored and expired entries rather than losing them", async () => {
    const base = new FakeTranslationModelClient();
    const client = new FaultInjectingModelClient(base, {
      batchOutcomes: { "ep1:1": "errored", "ep1:2": "expired" },
    });
    const plan = planFor("ep1", 10, 4);
    const { batchId } = await submitEconomyBatch(client, [
      { context: context("de", { lane: "economy" }), glossary: emptyGlossary(), plan },
    ]);
    const byId = new Map(plan.map((entry) => [entry.customId, entry]));
    const collected = await collectEconomyBatch(client, batchId, byId, DEFAULT_HARNESS_CONFIG);
    expect(collected.get("ep1:0")?.error).toBeNull();
    expect(collected.get("ep1:1")?.error).toMatch(/failed inside the Message Batch/);
    expect(collected.get("ep1:2")?.error).toMatch(/came back expired/);
  });

  it("records an entry the batch never mentioned at all", async () => {
    const client = new FakeTranslationModelClient();
    const plan = planFor("ep1", 10, 4);
    const { batchId } = await submitEconomyBatch(client, [
      { context: context("de", { lane: "economy" }), glossary: emptyGlossary(), plan },
    ]);
    const byId = new Map(plan.map((entry) => [entry.customId, entry]));
    byId.set("ep1:9", { index: 9, customId: "ep1:9", cues: [{ id: 999, lines: ["Missing."] }] });
    const collected = await collectEconomyBatch(client, batchId, byId, DEFAULT_HARNESS_CONFIG);
    expect(collected.get("ep1:9")?.error).toMatch(/returned no result/);
  });

  it("gives up on a batch that never ends", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      batchNeverEnds: true,
    });
    const plan = planFor("ep1", 4, 4);
    const { batchId } = await submitEconomyBatch(client, [
      { context: context("de", { lane: "economy" }), glossary: emptyGlossary(), plan },
    ]);
    const byId = new Map(plan.map((entry) => [entry.customId, entry]));
    let slept = 0;
    await expect(
      collectEconomyBatch(client, batchId, byId, DEFAULT_HARNESS_CONFIG, {
        pollIntervalMs: 1000,
        maxWaitMs: 5000,
        wait: (ms) => {
          slept += ms;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(BatchNeverEndedError);
    expect(slept).toBe(5000);
  });
});
