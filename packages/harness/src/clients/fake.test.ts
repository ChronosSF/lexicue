import { parseSubtitleText } from "@lexicue/subtitles";
import { describe, expect, it } from "vitest";
import { DEFAULT_HARNESS_CONFIG } from "../config.js";
import { findTargetLanguage } from "../languages.js";
import type { ModelResponse } from "../model-client.js";
import { LINE_MARKER } from "../prompts/render.js";
import {
  buildBatchRequest,
  buildGlossaryRequest,
  buildSourceDocument,
  type RequestContext,
} from "../requests.js";
import { emptyGlossary, type BatchTranslation } from "../schemas.js";
import { toProtocolCue, type TranslationOptions } from "../types.js";
import { FakeTranslationModelClient, cachedPrefix, estimateTokens } from "./fake.js";
import { FaultInjectingModelClient } from "./fault.js";

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
  "{y:i}Then we row out at first light.",
  "",
  "",
].join("\n");

const CUES = parseSubtitleText(SRT).cues.map(toProtocolCue);

function context(overrides: Partial<TranslationOptions> = {}): RequestContext {
  const german = findTargetLanguage("de");
  if (german === undefined) throw new Error("German is missing from the target list");
  const options: TranslationOptions = {
    target: german,
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
    sourceDocument: buildSourceDocument(CUES),
  };
}

function cuesOf(response: ModelResponse<BatchTranslation>): BatchTranslation["cues"] {
  const parsed = response.parsed;
  if (parsed === null) throw new Error("the client returned no parsed output");
  return parsed.cues;
}

function batchRequest(): ReturnType<typeof buildBatchRequest> {
  return buildBatchRequest(context(), { glossary: emptyGlossary(), cues: CUES });
}

describe("the fake client", () => {
  it("wraps the words of every cue and returns the ids it was asked for", async () => {
    const client = new FakeTranslationModelClient();
    const response = await client.complete(batchRequest());

    expect(response.stopReason).toBe("end_turn");
    const cues = cuesOf(response);
    expect(cues.map((cue) => cue.i)).toEqual([1, 2, 3]);
    expect(cues[0]?.t).toBe("«The lighthouse has been dark for a week.»");
  });

  it("leaves inline tags exactly where they were", async () => {
    const client = new FakeTranslationModelClient();
    const cues = cuesOf(await client.complete(batchRequest()));
    expect(cues[1]?.t).toBe(`- «And nobody thought to call?»${LINE_MARKER}- <i>«We called.»</i>`);
  });

  it("never sees a control code that the parser stripped off the front of a cue", async () => {
    const client = new FakeTranslationModelClient();
    const cues = cuesOf(await client.complete(batchRequest()));
    expect(cues[2]?.t).toBe("«Then we row out at first light.»");
    expect(parseSubtitleText(SRT).cues[2]?.prefixCodes).toBe("{y:i}");
  });

  it("keeps a control code that sits inside a line, where the model can see it", () => {
    const client = new FakeTranslationModelClient();
    expect(client.translateLine("- {y:i}Never.")).toBe("- {y:i}«Never.»");
  });

  it("keeps the speaker dash outside the translated words", () => {
    const client = new FakeTranslationModelClient();
    expect(client.translateLine("- Never.")).toBe("- «Never.»");
    expect(client.translateLine("<i>Never.</i>")).toBe("<i>«Never.»</i>");
  });

  it("can be told to mark its output, which the season fixture uses", () => {
    const client = new FakeTranslationModelClient({ prefix: "S1:" });
    expect(client.translateLine("Yes.")).toBe("S1:«Yes.»");
  });

  it("answers a glossary request with the shape the schema demands", async () => {
    const client = new FakeTranslationModelClient({
      sourceLanguage: "English",
      glossaryCharacters: [{ name: "Marta", rendered: "Marta", notes: "keeper" }],
    });
    const response = await client.complete(buildGlossaryRequest(context(), null));
    expect(response.parsed?.sourceLanguage).toBe("English");
    expect(response.parsed?.characters[0]?.rendered).toBe("Marta");
  });

  it("estimates tokens without pretending to be Claude's tokenizer", async () => {
    const client = new FakeTranslationModelClient();
    const request = batchRequest();
    const count = await client.countTokens({
      model: request.model,
      system: request.system,
      user: request.user,
    });
    const text = [...request.system, ...request.user].map((block) => block.text).join("\n");
    expect(count).toBe(estimateTokens(text));
  });
});

describe("the cached prefix", () => {
  it("is byte identical across two batches of the same job", () => {
    const ctx = context();
    const first = buildBatchRequest(ctx, { glossary: emptyGlossary(), cues: CUES.slice(0, 2) });
    const second = buildBatchRequest(ctx, { glossary: emptyGlossary(), cues: CUES.slice(2) });
    expect(cachedPrefix(second)).toBe(cachedPrefix(first));
    expect(first.user[1]?.text).not.toBe(second.user[1]?.text);
  });

  it("is byte identical between the glossary pass and the batches", () => {
    const ctx = context();
    const glossary = buildGlossaryRequest(ctx, null);
    const batch = buildBatchRequest(ctx, { glossary: emptyGlossary(), cues: CUES });
    expect(cachedPrefix(batch)).toBe(cachedPrefix(glossary));
  });

  it("reports a cache write on the first request of a job and reads after it", async () => {
    const client = new FakeTranslationModelClient();
    const ctx = context();
    const first = await client.complete(buildGlossaryRequest(ctx, null));
    const second = await client.complete(
      buildBatchRequest(ctx, { glossary: emptyGlossary(), cues: CUES }),
    );
    expect(first.usage.cacheCreationInputTokens).toBeGreaterThan(0);
    expect(first.usage.cacheReadInputTokens).toBe(0);
    expect(second.usage.cacheCreationInputTokens).toBe(0);
    expect(second.usage.cacheReadInputTokens).toBeGreaterThan(0);
  });

  it("uses the one-hour breakpoint on the economy lane", () => {
    const ctx = context({ lane: "economy" });
    const request = buildGlossaryRequest(ctx, null);
    expect(request.system[0]?.cacheControl?.ttl).toBe("1h");
    expect(request.user[0]?.cacheControl?.ttl).toBe("1h");
  });
});

describe("the fault-injecting client", () => {
  it("passes answers through untouched when the script is empty", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient());
    expect(cuesOf(await client.complete(batchRequest()))).toHaveLength(3);
  });

  it("drops, duplicates and adds ids to order", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [
        { kind: "drop-ids", ids: [2] },
        { kind: "duplicate-ids", ids: [1] },
        { kind: "extra-ids", ids: [99] },
      ],
    });
    const dropped = cuesOf(await client.complete(batchRequest()));
    const duplicated = cuesOf(await client.complete(batchRequest()));
    const extra = cuesOf(await client.complete(batchRequest()));

    expect(dropped.map((cue) => cue.i)).toEqual([1, 3]);
    expect(duplicated.filter((cue) => cue.i === 1)).toHaveLength(2);
    expect(extra.map((cue) => cue.i)).toContain(99);
  });

  it("damages tags, empties cues and leaks commentary to order", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [
        { kind: "drop-tags", ids: [2] },
        { kind: "empty", ids: [1] },
        { kind: "leak", ids: [3] },
      ],
    });
    const noTags = cuesOf(await client.complete(batchRequest()));
    const empty = cuesOf(await client.complete(batchRequest()));
    const leaked = cuesOf(await client.complete(batchRequest()));

    expect(noTags[1]?.t).not.toContain("<i>");
    expect(empty[0]?.t).toBe("");
    expect(leaked[2]?.t).toContain("translator's note");
  });

  it("reports the stop reasons the harness has to act on", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [
        { kind: "stop", reason: "max_tokens" },
        { kind: "stop", reason: "refusal", category: "cyber" },
        { kind: "unparseable" },
      ],
    });
    expect((await client.complete(batchRequest())).stopReason).toBe("max_tokens");
    const refused = await client.complete(batchRequest());
    expect(refused.stopReason).toBe("refusal");
    expect(refused.refusalCategory).toBe("cyber");
    expect((await client.complete(batchRequest())).parsed).toBeNull();
  });

  it("throws a transport error for a 429 or a 500", async () => {
    const client = new FaultInjectingModelClient(new FakeTranslationModelClient(), {
      script: [
        { kind: "http", status: 429 },
        { kind: "http", status: 500 },
      ],
    });
    await expect(client.complete(batchRequest())).rejects.toThrow(/429/);
    await expect(client.complete(batchRequest())).rejects.toThrow(/500/);
  });
});
