import { ModelTransportError } from "../errors.js";
import type { BatchTranslation } from "../schemas.js";
import type {
  BatchModelClient,
  BatchOutcome,
  BatchRequestItem,
  BatchResultItem,
  BatchStatus,
  ModelRequest,
  ModelResponse,
  TokenCountRequest,
} from "../model-client.js";

/**
 * The faults spec section 10.2 requires a test for. Each one is a thing a real
 * model or a real API has been observed to do.
 */
export type Fault =
  /** Ids the answer leaves out. */
  | { kind: "drop-ids"; ids: number[] }
  /** Ids the answer returns twice. */
  | { kind: "duplicate-ids"; ids: number[] }
  /** Ids that were never asked for. */
  | { kind: "extra-ids"; ids: number[] }
  /** Cues answered with an empty string. */
  | { kind: "empty"; ids: number[] }
  /** Cues whose inline tags were stripped. */
  | { kind: "drop-tags"; ids: number[] }
  /** Cues that gained a tag the source did not have. */
  | { kind: "add-tag"; ids: number[]; tag: string }
  /** Cues left in Latin letters for a non-Latin target. */
  | { kind: "untranslated"; ids: number[]; text?: string }
  /** Cues carrying commentary, an id or a placeholder marker. */
  | { kind: "leak"; ids: number[]; text?: string }
  /** Cues answered with more lines than the source had. */
  | { kind: "extra-lines"; ids: number[] }
  /** A stop reason other than end_turn. */
  | { kind: "stop"; reason: "max_tokens" | "refusal"; category?: string }
  /** An HTTP failure from the API. */
  | { kind: "http"; status: number; message?: string }
  /** A response the API could not fit to the schema. */
  | { kind: "unparseable" };

export interface FaultInjectingOptions {
  /**
   * One entry per `complete` call, in order; `null` means "answer normally".
   * When the script runs out, every later call is answered normally.
   */
  script?: (Fault | null)[];
  /** Faults applied to specific Message Batch entries, keyed by custom id. */
  batchOutcomes?: Record<string, BatchOutcome>;
  /** When set, the batch never reaches the "ended" state. */
  batchNeverEnds?: boolean;
}

/**
 * Wraps another client and corrupts its answers to order (spec section 10.2).
 * Every fault is applied to a real answer from the wrapped client, so a test
 * proves the harness recovers from damage rather than from a stub.
 */
export class FaultInjectingModelClient implements BatchModelClient {
  readonly name = "fault-injecting";
  readonly retriesTransportErrors = false;

  /** How many times `complete` has been called. */
  calls = 0;

  private readonly base: BatchModelClient;
  private readonly script: (Fault | null)[];
  private readonly batchOutcomes: Record<string, BatchOutcome>;
  private readonly batchNeverEnds: boolean;

  constructor(base: BatchModelClient, options: FaultInjectingOptions = {}) {
    this.base = base;
    this.script = options.script ?? [];
    this.batchOutcomes = options.batchOutcomes ?? {};
    this.batchNeverEnds = options.batchNeverEnds ?? false;
  }

  async complete<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
    const fault = this.script[this.calls] ?? null;
    this.calls += 1;
    if (fault?.kind === "http") {
      throw new ModelTransportError(
        fault.message ?? `The model API returned ${fault.status.toString()}.`,
        { status: fault.status },
      );
    }
    const response = await this.base.complete(request);
    return applyFault(response, fault);
  }

  countTokens(request: TokenCountRequest): Promise<number> {
    return this.base.countTokens(request);
  }

  submitBatch(requests: BatchRequestItem[]): Promise<string> {
    return this.base.submitBatch(requests);
  }

  async getBatch(batchId: string): Promise<BatchStatus> {
    const status = await this.base.getBatch(batchId);
    if (!this.batchNeverEnds) return status;
    return { ...status, processingStatus: "in_progress", endedAt: null };
  }

  async *streamBatchResults(batchId: string): AsyncIterable<BatchResultItem> {
    for await (const item of this.base.streamBatchResults(batchId)) {
      const outcome = this.batchOutcomes[item.customId];
      if (outcome !== undefined && outcome !== "succeeded") {
        yield {
          customId: item.customId,
          outcome,
          response: null,
          error: outcome === "errored" ? "The request failed inside the Message Batch." : null,
        };
        continue;
      }
      const fault = this.script[this.calls] ?? null;
      this.calls += 1;
      yield item.response === null ? item : { ...item, response: applyFault(item.response, fault) };
    }
  }
}

/** Applies one fault to an answer. Exported so tests can build their own fakes. */
export function applyFault<T>(response: ModelResponse<T>, fault: Fault | null): ModelResponse<T> {
  if (fault === null) return response;
  switch (fault.kind) {
    case "stop":
      return {
        ...response,
        stopReason: fault.reason,
        refusalCategory: fault.reason === "refusal" ? (fault.category ?? "cyber") : null,
        parsed: null,
      };
    case "unparseable":
      return { ...response, parsed: null };
    case "http":
      return response;
    default:
      return { ...response, parsed: corrupt(response.parsed, fault) };
  }
}

function corrupt<T>(parsed: T | null, fault: Fault): T | null {
  if (parsed === null || !isBatchTranslation(parsed)) return parsed;
  const cues = parsed.cues.map((cue) => ({ ...cue }));
  const affected = (ids: number[]): typeof cues => cues.filter((cue) => ids.includes(cue.i));

  switch (fault.kind) {
    case "drop-ids":
      return { cues: cues.filter((cue) => !fault.ids.includes(cue.i)) } as T;
    case "duplicate-ids":
      return { cues: [...cues, ...affected(fault.ids).map((cue) => ({ ...cue }))] } as T;
    case "extra-ids":
      return {
        cues: [...cues, ...fault.ids.map((id) => ({ i: id, t: "A cue nobody asked for." }))],
      } as T;
    case "empty":
      for (const cue of affected(fault.ids)) cue.t = "";
      return { cues } as T;
    case "drop-tags":
      for (const cue of affected(fault.ids)) cue.t = cue.t.replace(/<[^<>]*>/g, "");
      return { cues } as T;
    case "add-tag":
      for (const cue of affected(fault.ids)) cue.t = `${fault.tag}${cue.t}`;
      return { cues } as T;
    case "untranslated":
      for (const cue of affected(fault.ids)) cue.t = fault.text ?? "Untranslated English line.";
      return { cues } as T;
    case "leak":
      for (const cue of affected(fault.ids)) {
        cue.t = fault.text ?? `${cue.i.toString()}\t${cue.t} (translator's note: unclear)`;
      }
      return { cues } as T;
    case "extra-lines":
      for (const cue of affected(fault.ids)) cue.t = `${cue.t}⏎second⏎third`;
      return { cues } as T;
    default:
      return { cues } as T;
  }
}

function isBatchTranslation(value: unknown): value is BatchTranslation {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as { cues?: unknown }).cues)
  );
}
