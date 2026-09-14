import Anthropic from "@anthropic-ai/sdk";
import { parseSubtitleText } from "@lexicue/subtitles";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HARNESS_CONFIG, resolveConfig } from "../config.js";
import { HarnessConfigError, ModelTransportError } from "../errors.js";
import { findTargetLanguage } from "../languages.js";
import { buildBatchRequest, buildSourceDocument, type RequestContext } from "../requests.js";
import { emptyGlossary } from "../schemas.js";
import { toProtocolCue, type TranslationOptions } from "../types.js";
import {
  AnthropicTranslationClient,
  mapStopReason,
  mapUsage,
  toBatchResultItem,
  toCreateParams,
  toOutputConfig,
  toTextBlock,
  toTransportError,
} from "./anthropic.js";

const SRT = ["1", "00:00:01,000 --> 00:00:03,000", "Hello there.", "", ""].join("\n");

function context(lane: "fast" | "economy" = "fast", model?: string): RequestContext {
  const target = findTargetLanguage("de");
  if (target === undefined) throw new Error("de missing");
  const options: TranslationOptions = {
    target,
    lane,
    formality: "auto",
    contextNote: "",
    lineHandling: "reflow",
    translateLyrics: true,
  };
  return {
    config: resolveConfig(model === undefined ? {} : { model }),
    options,
    jobId: "job-1",
    sourceDocument: buildSourceDocument(parseSubtitleText(SRT).cues.map(toProtocolCue)),
  };
}

function request(
  lane: "fast" | "economy" = "fast",
  model?: string,
): ReturnType<typeof buildBatchRequest> {
  return buildBatchRequest(context(lane, model), {
    glossary: emptyGlossary("English"),
    cues: parseSubtitleText(SRT).cues.map(toProtocolCue),
  });
}

describe("the request the SDK is given", () => {
  it("puts the cache breakpoint on the system prompt and the source document", () => {
    const params = toCreateParams(request());
    const system = params.system;
    if (!Array.isArray(system)) throw new Error("system must be an array of blocks");
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });

    const content = params.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("content must be an array of blocks");
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral", ttl: "5m" },
    });
    // The batch-specific text comes last and carries no breakpoint, so the
    // prefix bytes are identical across every request of the job.
    expect(content[1]).not.toHaveProperty("cache_control");
  });

  it("uses the one-hour breakpoint on the economy lane", () => {
    const params = toCreateParams(request("economy"));
    const system = params.system;
    if (!Array.isArray(system)) throw new Error("system must be an array of blocks");
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("sets the effort and a structured-output format, and no sampling parameters", () => {
    const params = toCreateParams(request());
    expect(params.output_config?.effort).toBe("medium");
    expect(params.output_config?.format).toMatchObject({ type: "json_schema" });
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("top_k");
    expect(params.max_tokens).toBe(DEFAULT_HARNESS_CONFIG.maxTokens);
  });

  /**
   * Haiku 4.5 answers a request carrying `output_config.effort` with an error
   * rather than ignoring the field, so it has to be left off entirely. The
   * structured-output format stays, because Haiku 4.5 does support it: the
   * request shape is otherwise identical, which is what keeps the two arms of a
   * model comparison comparable.
   */
  it("leaves the effort off for a model that rejects it, and keeps the format", () => {
    const params = toCreateParams(request("fast", "claude-haiku-4-5"));
    expect(params.output_config).not.toHaveProperty("effort");
    expect(params.output_config?.format).toMatchObject({ type: "json_schema" });
    expect(params.model).toBe("claude-haiku-4-5");
    expect(params.max_tokens).toBe(DEFAULT_HARNESS_CONFIG.maxTokens);
  });

  /** Neither model is ever asked to think: Sonnet 5 adapts, Haiku 4.5 does not think. */
  it("never sends a thinking parameter on any model", () => {
    expect(toCreateParams(request())).not.toHaveProperty("thinking");
    expect(toCreateParams(request("fast", "claude-haiku-4-5"))).not.toHaveProperty("thinking");
  });

  it("refuses a model that cannot do structured outputs rather than guessing", () => {
    // No current model needs this, but a table entry saying so must stop the
    // run rather than silently send a field the model will reject.
    expect(() =>
      toOutputConfig(request(), {
        acceptsEffort: true,
        thinking: "adaptive",
        acceptsStructuredOutputs: false,
        minimumCacheablePrefixTokens: 1024,
      }),
    ).toThrow(HarnessConfigError);
  });

  it("never sends an assistant turn, so there is no prefill", () => {
    const params = toCreateParams(request());
    expect(params.messages.every((message) => message.role === "user")).toBe(true);
  });

  it("renders a block without a breakpoint as a plain text block", () => {
    expect(toTextBlock({ text: "hello" })).toEqual({ type: "text", text: "hello" });
  });
});

describe("mapping the response", () => {
  it("reduces the SDK's stop reasons to the cases the harness acts on", () => {
    expect(mapStopReason("end_turn")).toBe("end_turn");
    expect(mapStopReason("max_tokens")).toBe("max_tokens");
    expect(mapStopReason("model_context_window_exceeded")).toBe("max_tokens");
    expect(mapStopReason("refusal")).toBe("refusal");
    expect(mapStopReason("tool_use")).toBe("other");
    expect(mapStopReason(null)).toBe("other");
  });

  it("copies every usage field the cost metric needs", () => {
    const usage: Anthropic.Usage = {
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 400,
      cache_creation: { ephemeral_5m_input_tokens: 250, ephemeral_1h_input_tokens: 50 },
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    };
    expect(mapUsage(usage)).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 400,
      cacheCreation5mInputTokens: 250,
      cacheCreation1hInputTokens: 50,
    });
  });

  it("treats missing cache fields as zero", () => {
    const usage = {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    } satisfies Anthropic.Usage;
    expect(mapUsage(usage).cacheReadInputTokens).toBe(0);
    expect(mapUsage(usage).cacheCreation1hInputTokens).toBe(0);
  });
});

function message(text: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 30,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "batch",
    },
  };
}

describe("Message Batch results", () => {
  it("reads the structured output out of a succeeded entry", () => {
    const item = toBatchResultItem({
      custom_id: "job-1_0",
      result: { type: "succeeded", message: message('{"cues":[{"i":1,"t":"Hallo."}]}') },
    });
    expect(item.outcome).toBe("succeeded");
    expect(item.response?.parsed).toEqual({ cues: [{ i: 1, t: "Hallo." }] });
    expect(item.response?.usage.cacheReadInputTokens).toBe(30);
  });

  it("reports null rather than throwing when an entry is not JSON", () => {
    const item = toBatchResultItem({
      custom_id: "job-1_0",
      result: { type: "succeeded", message: message("I am sorry, but") },
    });
    expect(item.response?.parsed).toBeNull();
  });

  it("carries the error of an errored entry", () => {
    const item = toBatchResultItem({
      custom_id: "job-1_1",
      result: {
        type: "errored",
        error: {
          type: "error",
          request_id: null,
          error: { type: "api_error", message: "Internal server error" },
        },
      },
    });
    expect(item.outcome).toBe("errored");
    expect(item.error).toBe("api_error: Internal server error");
    expect(item.response).toBeNull();
  });

  it("carries an expired and a canceled entry without an error message", () => {
    expect(toBatchResultItem({ custom_id: "a", result: { type: "expired" } })).toMatchObject({
      outcome: "expired",
      error: null,
    });
    expect(toBatchResultItem({ custom_id: "a", result: { type: "canceled" } })).toMatchObject({
      outcome: "canceled",
      error: null,
    });
  });
});

describe("error mapping", () => {
  it("turns a rate limit into a retryable transport error", () => {
    const mapped = toTransportError(
      new Anthropic.RateLimitError(429, new Headers(), "rate limited", new Headers()),
    );
    expect(mapped).toBeInstanceOf(ModelTransportError);
    expect((mapped as ModelTransportError).status).toBe(429);
    expect((mapped as ModelTransportError).retryable).toBe(true);
  });

  it("turns a bad request into a transport error that is not retried", () => {
    const mapped = toTransportError(
      new Anthropic.BadRequestError(400, new Headers(), "bad request", new Headers()),
    );
    expect((mapped as ModelTransportError).retryable).toBe(false);
  });

  it("treats a connection failure as retryable", () => {
    const mapped = toTransportError(
      new Anthropic.APIConnectionError({ message: "socket hang up" }),
    );
    expect((mapped as ModelTransportError).retryable).toBe(true);
  });

  it("leaves an error that is not the API's alone", () => {
    const bug = new TypeError("a bug in the harness");
    expect(toTransportError(bug)).toBe(bug);
  });
});

describe("the client against a stubbed SDK", () => {
  /**
   * The SDK surface the client uses. Stubbing it keeps this test offline while
   * still exercising the exact call shapes, which were checked against the
   * installed type definitions.
   */
  function stub(overrides: {
    parse?: unknown;
    countTokens?: unknown;
    create?: unknown;
    retrieve?: unknown;
    results?: unknown;
  }): Anthropic {
    return {
      messages: {
        parse: overrides.parse,
        countTokens: overrides.countTokens,
        batches: {
          create: overrides.create,
          retrieve: overrides.retrieve,
          results: overrides.results,
        },
      },
    } as unknown as Anthropic;
  }

  it("passes the built request to messages.parse and maps the answer back", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { cues: [{ i: 1, t: "Hallo." }] },
      stop_reason: "end_turn",
      stop_details: null,
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 5,
        output_tokens: 6,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 8,
        cache_creation: null,
      },
    });
    const client = new AnthropicTranslationClient({ client: stub({ parse }) });
    const response = await client.complete(request());

    expect(response.parsed).toEqual({ cues: [{ i: 1, t: "Hallo." }] });
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage.cacheReadInputTokens).toBe(8);
    expect(client.retriesTransportErrors).toBe(true);

    const sent = parse.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(sent.model).toBe("claude-sonnet-5");
    expect(sent.output_config?.effort).toBe("medium");
  });

  it("sends no effort to Haiku 4.5 on the interactive path either", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { cues: [{ i: 1, t: "Hallo." }] },
      stop_reason: "end_turn",
      stop_details: null,
      model: "claude-haiku-4-5",
      usage: { input_tokens: 5, output_tokens: 6 },
    });
    const client = new AnthropicTranslationClient({ client: stub({ parse }) });
    const response = await client.complete(request("fast", "claude-haiku-4-5"));

    // The model that actually answered is carried back, so a run can never
    // attribute one model's work to another.
    expect(response.model).toBe("claude-haiku-4-5");
    const sent = parse.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(sent.model).toBe("claude-haiku-4-5");
    expect(sent.output_config).not.toHaveProperty("effort");
    expect(sent.output_config?.format).toMatchObject({ type: "json_schema" });
  });

  it("reports a refusal category from stop_details", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: null,
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "no" },
      model: "claude-sonnet-5",
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const client = new AnthropicTranslationClient({ client: stub({ parse }) });
    const response = await client.complete(request());
    expect(response.stopReason).toBe("refusal");
    expect(response.refusalCategory).toBe("cyber");
  });

  it("maps an SDK error onto a transport error", async () => {
    const parse = vi
      .fn()
      .mockRejectedValue(
        new Anthropic.InternalServerError(500, new Headers(), "boom", new Headers()),
      );
    const client = new AnthropicTranslationClient({ client: stub({ parse }) });
    await expect(client.complete(request())).rejects.toBeInstanceOf(ModelTransportError);
  });

  it("counts tokens through the API's own endpoint", async () => {
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: 1234 });
    const client = new AnthropicTranslationClient({ client: stub({ countTokens }) });
    const built = request();
    const count = await client.countTokens({
      model: built.model,
      system: built.system,
      user: built.user,
    });
    expect(count).toBe(1234);
    const sent = countTokens.mock.calls[0]?.[0] as Anthropic.MessageCountTokensParams;
    expect(sent.model).toBe("claude-sonnet-5");
  });

  it("submits, polls and streams a Message Batch", async () => {
    const create = vi.fn().mockResolvedValue({ id: "msgbatch_01" });
    const retrieve = vi.fn().mockResolvedValue({
      id: "msgbatch_01",
      processing_status: "ended",
      ended_at: "2026-09-09T00:00:00Z",
      request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
    });
    const results = vi.fn().mockResolvedValue([
      {
        custom_id: "job-1_0",
        result: { type: "succeeded", message: message('{"cues":[{"i":1,"t":"Hallo."}]}') },
      },
    ]);
    const client = new AnthropicTranslationClient({ client: stub({ create, retrieve, results }) });

    const batchId = await client.submitBatch([
      { customId: "job-1_0", request: request("economy") },
    ]);
    expect(batchId).toBe("msgbatch_01");
    const sent = create.mock.calls[0]?.[0] as Anthropic.Messages.BatchCreateParams;
    expect(sent.requests[0]?.custom_id).toBe("job-1_0");
    expect(sent.requests[0]?.params.output_config?.format).toMatchObject({ type: "json_schema" });

    const status = await client.getBatch("msgbatch_01");
    expect(status.processingStatus).toBe("ended");
    expect(status.counts.succeeded).toBe(1);

    const collected = [];
    for await (const item of client.streamBatchResults("msgbatch_01")) collected.push(item);
    expect(collected).toHaveLength(1);
    expect(collected[0]?.response?.parsed).toEqual({ cues: [{ i: 1, t: "Hallo." }] });
  });
});
