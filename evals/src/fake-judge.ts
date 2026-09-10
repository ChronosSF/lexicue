import {
  FakeTranslationModelClient,
  emptyUsage,
  type FakeClientOptions,
  type ModelRequest,
  type ModelResponse,
  type BatchModelClient,
  type BatchRequestItem,
  type BatchResultItem,
  type BatchStatus,
  type TokenCountRequest,
} from "@subtitle-translator/harness";
import type { Judgement, SeasonConsistency } from "./rubric.js";

/**
 * The fake client the eval runner uses in CI: the harness's deterministic fake
 * for translation, plus a deterministic verdict for the judge, so the whole
 * runner can be exercised end to end without spending a token.
 *
 * The verdict is fixed on purpose. It proves the runner's plumbing — sampling,
 * averaging, the lowest-score list, the results file — and says nothing about
 * quality, which only the real judge can.
 */
export class FakeJudgeModelClient implements BatchModelClient {
  readonly name = "fake";
  readonly retriesTransportErrors = false;

  private readonly translation: FakeTranslationModelClient;
  private readonly score: number;

  constructor(options: FakeClientOptions & { score?: number } = {}) {
    this.translation = new FakeTranslationModelClient(options);
    this.score = options.score ?? 4;
  }

  complete<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
    if (request.purpose !== "judge") return this.translation.complete(request);
    return Promise.resolve({
      parsed: this.verdict(request) as T,
      stopReason: "end_turn",
      refusalCategory: null,
      usage: emptyUsage(),
      model: request.model,
    });
  }

  countTokens(request: TokenCountRequest): Promise<number> {
    return this.translation.countTokens(request);
  }

  submitBatch(requests: BatchRequestItem[]): Promise<string> {
    return this.translation.submitBatch(requests);
  }

  getBatch(batchId: string): Promise<BatchStatus> {
    return this.translation.getBatch(batchId);
  }

  streamBatchResults(batchId: string): AsyncIterable<BatchResultItem> {
    return this.translation.streamBatchResults(batchId);
  }

  private verdict<T>(request: ModelRequest<T>): Judgement | SeasonConsistency {
    const body = request.user.at(-1)?.text ?? "";
    if (request.jobId === "season-consistency") {
      return { consistent: true, findings: [] } satisfies SeasonConsistency;
    }
    const verdicts = body
      .split("\n")
      .map((line) => Number(line.slice(0, line.indexOf("\t"))))
      .filter((id) => Number.isInteger(id) && id > 0)
      .map((id) => ({
        i: id,
        accuracy: this.score,
        naturalness: this.score,
        register: this.score,
        nameConsistency: this.score,
        note: "",
      }));
    return {
      verdicts,
      summary: "Scored by the fake judge; these numbers measure the runner, not the translation.",
    } satisfies Judgement;
  }
}
