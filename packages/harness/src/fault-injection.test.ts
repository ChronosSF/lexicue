import { parseSubtitleText } from "@lexicue/subtitles";
import { describe, expect, it } from "vitest";
import { FakeTranslationModelClient } from "./clients/fake.js";
import { FaultInjectingModelClient, type Fault } from "./clients/fault.js";
import { resolveConfig } from "./config.js";
import { findTargetLanguage } from "./languages.js";
import { translateFile, type TranslatedFile } from "./translate-file.js";
import { translateUpload } from "./translate-upload.js";
import type { TranslationJob, TranslationOptions } from "./types.js";

/**
 * Every fault of spec section 10.2, driven all the way through the harness so
 * that each one has a test asserting the retry, split, fallback, re-run or flag
 * behaviour of sections 4.5 and 4.6 — not just the validator's opinion of it.
 */

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,240",
  "The lighthouse has been dark for a week.",
  "",
  "2",
  "00:00:03,400 --> 00:00:06,120",
  "- And nobody thought to call?",
  "- <i>We called.</i>",
  "",
  "3",
  "00:00:06,300 --> 00:00:08,000",
  "Then we row out at first light.",
  "",
  "",
].join("\n");

function job(): TranslationJob {
  return { jobId: "job-1", fileName: "film.srt", document: parseSubtitleText(SRT) };
}

function options(code = "de", lane: "fast" | "economy" = "fast"): TranslationOptions {
  const target = findTargetLanguage(code);
  if (target === undefined) throw new Error(`unknown target ${code}`);
  return {
    target,
    lane,
    formality: "auto",
    contextNote: "",
    lineHandling: "reflow",
    translateLyrics: true,
  };
}

async function withFaults(
  script: (Fault | null)[],
  target = "de",
  fake: ConstructorParameters<typeof FakeTranslationModelClient>[0] = {},
): Promise<{ result: TranslatedFile; calls: number }> {
  const client = new FaultInjectingModelClient(new FakeTranslationModelClient(fake), { script });
  const result = await translateFile({
    client,
    config: resolveConfig({ batchSize: 3, concurrency: 1 }),
    options: options(target),
    job: job(),
  });
  return { result, calls: client.calls };
}

describe("the fake client proves the structural guarantees on both lanes", () => {
  it("returns a structurally identical file on the fast lane", async () => {
    const source = job();
    const upload = await translateUpload({
      client: new FakeTranslationModelClient(),
      config: resolveConfig({ batchSize: 2 }),
      options: options("de", "fast"),
      jobs: [source],
    });
    const file = upload.files[0];
    const reparsed = parseSubtitleText(file?.text ?? "");
    expect(reparsed.cues.map((cue) => cue.rawTimingLine)).toEqual(
      source.document.cues.map((cue) => cue.rawTimingLine),
    );
    expect(reparsed.cues.map((cue) => cue.rawIndexLine)).toEqual(
      source.document.cues.map((cue) => cue.rawIndexLine),
    );
  });

  it("returns exactly the same file on the economy lane", async () => {
    const jobs = [job()];
    const fast = await translateUpload({
      client: new FakeTranslationModelClient(),
      config: resolveConfig({ batchSize: 2 }),
      options: options("de", "fast"),
      jobs,
    });
    const economy = await translateUpload({
      client: new FakeTranslationModelClient(),
      config: resolveConfig({ batchSize: 2 }),
      options: options("de", "economy"),
      jobs,
      collect: { wait: () => Promise.resolve() },
    });
    expect(economy.files[0]?.text).toBe(fast.files[0]?.text);
  });
});

describe("answers that are wrong in a way the harness can repair", () => {
  it("strips a tag the model invented", async () => {
    const { result } = await withFaults([null, { kind: "add-tag", ids: [1], tag: "<b>" }]);
    expect(result.report.untranslatedCues).toEqual([]);
    expect(result.document.cues[0]?.lines.join("")).not.toContain("<b>");
  });

  it("re-flows an answer that grew extra lines", async () => {
    const { result } = await withFaults([null, { kind: "extra-lines", ids: [1] }]);
    expect(result.report.untranslatedCues).toEqual([]);
    expect(result.document.cues[0]?.lines.length).toBeLessThanOrEqual(2);
    expect(result.report.repairs.some((repair) => repair.includes("re-flowed"))).toBe(true);
  });

  it("drops an id nobody asked for and says so", async () => {
    const { result } = await withFaults([null, { kind: "extra-ids", ids: [99] }]);
    expect(result.report.untranslatedCues).toEqual([]);
    expect(result.report.warnings.some((warning) => warning.includes("Dropped cue 99"))).toBe(true);
  });
});

describe("answers that must be retried", () => {
  it("retries a duplicated id", async () => {
    const { result, calls } = await withFaults([null, { kind: "duplicate-ids", ids: [2] }]);
    expect(result.report.untranslatedCues).toEqual([]);
    // Glossary, batch, one retry.
    expect(calls).toBe(3);
  });

  it("retries a cue that leaked commentary", async () => {
    const { result } = await withFaults([null, { kind: "leak", ids: [3] }]);
    expect(result.report.untranslatedCues).toEqual([]);
    expect(result.document.cues[2]?.lines.join("")).not.toContain("translator");
  });

  it("retries a Latin answer for a Cyrillic target and flags it if it persists", async () => {
    const untranslated: Fault = {
      kind: "untranslated",
      ids: [1],
      text: "The lighthouse has been dark for a week.",
    };
    // The fake writes Cyrillic for every other cue, so only the faulted one
    // trips the script check.
    const { result } = await withFaults([null, untranslated, untranslated, untranslated], "bg", {
      prefix: "превод ",
    });
    expect(result.report.untranslatedCues.map((cue) => cue.id)).toEqual([1]);
    expect(result.report.untranslatedCues[0]?.reason).toMatch(/Latin letters/);
  });

  it("treats a whole file that came back in Latin as untranslated for a Cyrillic target", async () => {
    const { result } = await withFaults([null], "bg");
    expect(result.report.untranslatedCues).toHaveLength(3);
    expect(result.text).toContain("The lighthouse has been dark for a week.");
  });

  it("retries every cue of a batch the API could not fit to the schema", async () => {
    const { result, calls } = await withFaults([null, { kind: "unparseable" }]);
    expect(result.report.untranslatedCues).toEqual([]);
    expect(calls).toBe(3);
  });
});

describe("faults that reach the whole batch", () => {
  it("splits a max_tokens batch and keeps splitting until it fits", async () => {
    const { result } = await withFaults([
      null,
      { kind: "stop", reason: "max_tokens" },
      { kind: "stop", reason: "max_tokens" },
    ]);
    expect(result.report.untranslatedCues).toEqual([]);
    expect(result.report.warnings.filter((w) => w.includes("half batches")).length).toBe(2);
  });

  it("stops splitting when a single cue still hits the limit", async () => {
    const script: (Fault | null)[] = [null];
    for (let i = 0; i < 12; i += 1) script.push({ kind: "stop", reason: "max_tokens" });
    const { result } = await withFaults(script);
    // Every cue is left in the source language rather than the file failing.
    expect(result.report.untranslatedCues.length).toBeGreaterThan(0);
    expect(result.text).toContain("The lighthouse has been dark for a week.");
  });

  it("retries a 429 and succeeds on the second attempt", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [null, { kind: "http", status: 429 }],
    });
    const result = await translateFile({
      client,
      config: resolveConfig({ batchSize: 3, concurrency: 1, transportRetries: 2 }),
      options: options(),
      job: job(),
    });
    expect(result.report.untranslatedCues).toEqual([]);
  });
});
