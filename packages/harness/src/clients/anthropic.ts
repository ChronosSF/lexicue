import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ModelTransportError } from "../errors.js";
import type {
  BatchModelClient,
  BatchOutcome,
  BatchRequestItem,
  BatchResultItem,
  BatchStatus,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelUsage,
  PromptBlock,
  TokenCountRequest,
} from "../model-client.js";

export interface AnthropicClientOptions {
  /** Injected from Secrets Manager at cold start, or the environment locally. */
  apiKey?: string;
  /** An already-constructed SDK client, for tests and for other access paths. */
  client?: Anthropic;
  /** The SDK's own retry count. The spec keeps its default of two. */
  maxRetries?: number;
  /** The SDK's own timeout in milliseconds. The spec keeps its default of ten minutes. */
  timeout?: number;
}

/**
 * The production {@link BatchModelClient}: the Claude API through the official
 * SDK (spec sections 4.8 and 5.6).
 *
 * The system prompt and the whole source document carry explicit
 * `cache_control` breakpoints, and the batch-specific text comes after them, so
 * the prefix bytes are identical across every request of a job. Structured
 * outputs are enforced by the API through `zodOutputFormat`, not by parsing
 * prose. No sampling parameters are set — Sonnet 5 rejects them — and there is
 * no assistant prefill.
 *
 * The SDK's own timeout and its two automatic retries on 429 and 5xx responses
 * are left in place, which is why `retriesTransportErrors` is true: the harness
 * does not add a second layer of backoff on top of them.
 */
export class AnthropicTranslationClient implements BatchModelClient {
  readonly name = "anthropic";
  readonly retriesTransportErrors = true;

  private readonly client: Anthropic;

  constructor(options: AnthropicClientOptions = {}) {
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      });
  }

  async complete<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
    try {
      const response = await this.client.messages.parse({
        model: request.model,
        max_tokens: request.maxTokens,
        output_config: {
          effort: request.effort,
          format: zodOutputFormat(request.outputSchema),
        },
        system: request.system.map(toTextBlock),
        messages: [{ role: "user", content: request.user.map(toTextBlock) }],
      });
      return {
        parsed: response.parsed_output,
        stopReason: mapStopReason(response.stop_reason),
        refusalCategory: response.stop_details?.category ?? null,
        usage: mapUsage(response.usage),
        model: response.model,
      };
    } catch (error) {
      throw toTransportError(error);
    }
  }

  /**
   * Token counts for the ingestion gate come from the API's free endpoint,
   * never from a third-party tokenizer, because Claude's tokenizer differs from
   * others by 15 to 30% on non-English text (spec section 4.9).
   */
  async countTokens(request: TokenCountRequest): Promise<number> {
    try {
      const response = await this.client.messages.countTokens({
        model: request.model,
        system: request.system.map(toTextBlock),
        messages: [{ role: "user", content: request.user.map(toTextBlock) }],
      });
      return response.input_tokens;
    } catch (error) {
      throw toTransportError(error);
    }
  }

  async submitBatch(requests: BatchRequestItem[]): Promise<string> {
    try {
      const batch = await this.client.messages.batches.create({
        requests: requests.map((item) => ({
          custom_id: item.customId,
          params: toCreateParams(item.request),
        })),
      });
      return batch.id;
    } catch (error) {
      throw toTransportError(error);
    }
  }

  async getBatch(batchId: string): Promise<BatchStatus> {
    try {
      const batch = await this.client.messages.batches.retrieve(batchId);
      return {
        id: batch.id,
        processingStatus: batch.processing_status,
        endedAt: batch.ended_at,
        counts: {
          processing: batch.request_counts.processing,
          succeeded: batch.request_counts.succeeded,
          errored: batch.request_counts.errored,
          canceled: batch.request_counts.canceled,
          expired: batch.request_counts.expired,
        },
      };
    } catch (error) {
      throw toTransportError(error);
    }
  }

  async *streamBatchResults(batchId: string): AsyncIterable<BatchResultItem> {
    const results = await this.client.messages.batches.results(batchId);
    for await (const item of results) {
      yield toBatchResultItem(item);
    }
  }
}

/** Turns one harness prompt block into an SDK text block with its breakpoint. */
export function toTextBlock(block: PromptBlock): Anthropic.TextBlockParam {
  if (block.cacheControl === undefined) return { type: "text", text: block.text };
  return {
    type: "text",
    text: block.text,
    cache_control: { type: "ephemeral", ttl: block.cacheControl.ttl },
  };
}

/**
 * The same request object the interactive lane builds, handed to
 * `client.messages.batches.create` instead (spec section 4.5). Structured
 * outputs and prompt caching are both supported in batch requests.
 */
export function toCreateParams<T>(
  request: ModelRequest<T>,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    output_config: {
      effort: request.effort,
      format: zodOutputFormat(request.outputSchema),
    },
    system: request.system.map(toTextBlock),
    messages: [{ role: "user", content: request.user.map(toTextBlock) }],
  };
}

/** Reduces the SDK's stop reasons to the cases the harness acts on. */
export function mapStopReason(stopReason: Anthropic.StopReason | null): ModelStopReason {
  switch (stopReason) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/** Copies the usage fields spec section 4.8 sums onto the job. */
export function mapUsage(usage: Anthropic.Usage): ModelUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreation5mInputTokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cacheCreation1hInputTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
}

/**
 * One line of a Message Batch's results. A batch response is a plain Message,
 * not a parsed one, so the structured output is read out of its text content
 * and validated by the harness against the same schema.
 */
export function toBatchResultItem(
  item: Anthropic.Messages.MessageBatchIndividualResponse,
): BatchResultItem {
  const outcome: BatchOutcome = item.result.type;
  if (item.result.type !== "succeeded") {
    return {
      customId: item.custom_id,
      outcome,
      response: null,
      error:
        item.result.type === "errored"
          ? `${item.result.error.error.type}: ${item.result.error.error.message}`
          : null,
    };
  }
  const message = item.result.message;
  return {
    customId: item.custom_id,
    outcome: "succeeded",
    response: {
      parsed: readJsonOutput(message),
      stopReason: mapStopReason(message.stop_reason),
      refusalCategory: message.stop_details?.category ?? null,
      usage: mapUsage(message.usage),
      model: message.model,
    },
    error: null,
  };
}

function readJsonOutput(message: Anthropic.Message): unknown {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Maps an SDK error onto the harness's own transport error. */
export function toTransportError(error: unknown): unknown {
  // Most specific first: both of the classes below extend APIError.
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelTransportError(error.message, { retryable: true });
  }
  if (error instanceof Anthropic.APIError) {
    // The class is generic over its status, so the property widens to `any`
    // once `instanceof` narrows; check the value rather than trusting the type.
    const status: unknown = error.status;
    return new ModelTransportError(error.message, {
      ...(typeof status === "number" ? { status } : {}),
    });
  }
  return error;
}
