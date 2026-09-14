import { splitMarkup } from "@lexicue/subtitles";
import { LINE_MARKER } from "../prompts/render.js";
import type { BatchTranslation, CardPattern, Character, FileGlossary, Term } from "../schemas.js";
import type {
  BatchModelClient,
  BatchRequestItem,
  BatchResultItem,
  BatchStatus,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  TokenCountRequest,
} from "../model-client.js";

/**
 * A deterministic stand-in for the model (spec section 10.2). It wraps the
 * words of each cue in guillemets, leaving every inline tag and control code
 * untouched, which proves the structural guarantees independently of any model
 * and lets the whole command-line tool be demonstrated without an API key.
 */
export interface FakeClientOptions {
  /** The wrapper put around the translated words. Default `«` and `»`. */
  open?: string;
  close?: string;
  /** Prefix added to every translated run; the season fixture uses it. */
  prefix?: string;
  /** Characters the fake glossary reports. */
  glossaryCharacters?: Character[];
  /**
   * Characters derived from the text the glossary pass was given. The season
   * fixture uses this so a character who appears only late in episode two shows
   * up in that episode glossary and nowhere earlier.
   */
  charactersFromSource?: (sourceText: string) => Character[];
  /** Terms the fake glossary reports. */
  glossaryTerms?: Term[];
  /** Card patterns the fake glossary reports; the season fixture uses them. */
  glossaryCardPatterns?: CardPattern[];
  /** The source language the fake glossary claims to have detected. */
  sourceLanguage?: string;
}

export class FakeTranslationModelClient implements BatchModelClient {
  readonly name = "fake";
  readonly retriesTransportErrors = false;

  /** Every request the client was given, in order, for cache and prompt tests. */
  readonly requests: ModelRequest<unknown>[] = [];

  private readonly open: string;
  private readonly close: string;
  private readonly prefix: string;
  private readonly sourceLanguage: string;
  private readonly characters: Character[];
  private readonly charactersFromSource: ((sourceText: string) => Character[]) | null;
  private readonly terms: Term[];
  private readonly cardPatterns: CardPattern[];
  private readonly seenCacheKeys = new Set<string>();
  private readonly schemaIds = new WeakMap<object, string>();
  private schemaCounter = 0;
  private readonly batches = new Map<string, BatchRequestItem[]>();
  private batchCounter = 0;

  constructor(options: FakeClientOptions = {}) {
    this.open = options.open ?? "«";
    this.close = options.close ?? "»";
    this.prefix = options.prefix ?? "";
    this.sourceLanguage = options.sourceLanguage ?? "English";
    this.characters = options.glossaryCharacters ?? [];
    this.charactersFromSource = options.charactersFromSource ?? null;
    this.terms = options.glossaryTerms ?? [];
    this.cardPatterns = options.glossaryCardPatterns ?? [];
  }

  complete<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
    this.requests.push(request);
    return Promise.resolve({
      parsed: this.answer(request),
      stopReason: "end_turn",
      refusalCategory: null,
      usage: this.usage(request),
      model: request.model,
    });
  }

  countTokens(request: TokenCountRequest): Promise<number> {
    const text = [...request.system, ...request.user].map((block) => block.text).join("\n");
    return Promise.resolve(estimateTokens(text));
  }

  submitBatch(requests: BatchRequestItem[]): Promise<string> {
    this.batchCounter += 1;
    const id = `msgbatch_fake_${this.batchCounter.toString().padStart(3, "0")}`;
    this.batches.set(id, requests);
    return Promise.resolve(id);
  }

  getBatch(batchId: string): Promise<BatchStatus> {
    const requests = this.batches.get(batchId) ?? [];
    return Promise.resolve({
      id: batchId,
      processingStatus: "ended",
      endedAt: new Date(0).toISOString(),
      counts: { processing: 0, succeeded: requests.length, errored: 0, canceled: 0, expired: 0 },
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- an async generator is the interface's shape
  async *streamBatchResults(batchId: string): AsyncIterable<BatchResultItem> {
    const requests = this.batches.get(batchId) ?? [];
    // Results arrive in any order, so reversing them here makes every economy
    // lane test exercise the out-of-order path by default.
    for (const item of [...requests].reverse()) {
      yield {
        customId: item.customId,
        outcome: "succeeded",
        response: {
          parsed: this.answer(item.request),
          stopReason: "end_turn",
          refusalCategory: null,
          usage: this.usage(item.request),
          model: item.request.model,
        },
        error: null,
      };
    }
  }

  /** The deterministic transform, exposed so tests can state the expectation. */
  translateLine(line: string): string {
    return splitMarkup(line)
      .map((segment) => {
        if (segment.markup) return segment.value;
        const leading = /^\s*(?:-\s*)?/.exec(segment.value)?.[0] ?? "";
        const body = segment.value.slice(leading.length);
        if (body.trim() === "") return segment.value;
        const trailing = /\s*$/.exec(body)?.[0] ?? "";
        const core = body.slice(0, body.length - trailing.length);
        return `${leading}${this.prefix}${this.open}${core}${this.close}${trailing}`;
      })
      .join("");
  }

  private answer<T>(request: ModelRequest<T>): T | null {
    // A fake has to assert the shape its caller asked for; the schema in the
    // request is what a real client would hand to the API to enforce.
    if (request.purpose === "batch") {
      const { ids, cues } = parseBatchRequest(request);
      const answer: BatchTranslation = {
        cues: ids.map((id) => ({
          i: id,
          t: (cues.get(id) ?? "")
            .split(LINE_MARKER)
            .map((line) => this.translateLine(line))
            .join(LINE_MARKER),
        })),
      };
      return answer as T;
    }
    // A judge request belongs to the eval runner, which supplies its own client.
    if (request.purpose === "judge") return null;
    const sourceText = request.user[0]?.text ?? "";
    const glossary: FileGlossary = {
      sourceLanguage: this.sourceLanguage,
      register: "mixed",
      characters:
        this.charactersFromSource === null
          ? this.characters
          : [...this.characters, ...this.charactersFromSource(sourceText)],
      terms: this.terms,
      // The API enforces the schema, so a real glossary pass always answers
      // these two fields. The fake fixes each repeated line to its own
      // transform of that line, which is exactly what the batches will produce
      // for those cues: an offline test can then assert that the rendering the
      // glossary fixed is the rendering that comes back.
      repeatedLines: repeatedLinesIn(request).map((source) => ({
        source,
        target: this.translateLine(source),
      })),
      cardPatterns: this.cardPatterns,
      styleNotes: [`Fake client wraps dialogue in ${this.open}${this.close}`],
    };
    return glossary as T;
  }

  private usage<T>(request: ModelRequest<T>): ModelUsage {
    // The first request to land on a cache entry writes it and later ones read
    // it, which is what makes the cache-warning path testable without the API.
    const prefix = cachedPrefix(request);
    const prefixTokens = estimateTokens(prefix);
    const key = this.cacheKey(request, prefix);
    const isWrite = !this.seenCacheKeys.has(key);
    this.seenCacheKeys.add(key);
    const ttl = lastCacheTtl(request);
    const tail = request.user.at(-1)?.text ?? "";
    const tailTokens = estimateTokens(tail);
    return {
      inputTokens: tailTokens,
      outputTokens: Math.max(16, Math.round(tailTokens * 1.2)),
      cacheCreationInputTokens: isWrite ? prefixTokens : 0,
      cacheReadInputTokens: isWrite ? 0 : prefixTokens,
      cacheCreation5mInputTokens: isWrite && ttl === "5m" ? prefixTokens : 0,
      cacheCreation1hInputTokens: isWrite && ttl === "1h" ? prefixTokens : 0,
    };
  }

  /**
   * Which cache entry a request lands on. Identical prefix bytes are not
   * enough: measured against Sonnet 5 on 11 September 2026, two requests over
   * the same system prompt and the same source document did not share an entry
   * when their structured-output schemas differed — the output format renders
   * ahead of the system prompt, the way a tool list does, so it belongs to the
   * key. That is why a file's glossary pass cannot warm the prefix its batches
   * read, and why the first batch is the request that writes it.
   */
  private cacheKey<T>(request: ModelRequest<T>, prefix: string): string {
    return [request.jobId, this.schemaId(request.outputSchema), prefix].join(" ");
  }

  private schemaId(schema: object): string {
    const existing = this.schemaIds.get(schema);
    if (existing !== undefined) return existing;
    this.schemaCounter += 1;
    const id = `schema-${this.schemaCounter.toString()}`;
    this.schemaIds.set(schema, id);
    return id;
  }
}

/**
 * The bytes that must be byte-identical across every request of one job: every
 * block up to and including the last cache breakpoint.
 */
export function cachedPrefix<T>(request: ModelRequest<T>): string {
  const blocks = [...request.system, ...request.user];
  let lastBreakpoint = -1;
  for (const [index, block] of blocks.entries()) {
    if (block.cacheControl !== undefined) lastBreakpoint = index;
  }
  return blocks
    .slice(0, lastBreakpoint + 1)
    .map((block) => block.text)
    .join(" ");
}

function lastCacheTtl<T>(request: ModelRequest<T>): string {
  const blocks = [...request.system, ...request.user];
  let ttl = "5m";
  for (const block of blocks) {
    if (block.cacheControl !== undefined) ttl = block.cacheControl.ttl;
  }
  return ttl;
}

/**
 * Reads the repeated lines back out of a rendered glossary request, the way a
 * model reads them: from the text of the request and nothing else. The harness
 * detected them, so a fake that took them from anywhere but the prompt would
 * hide a prompt that failed to carry them.
 */
export function repeatedLinesIn<T>(request: ModelRequest<T>): string[] {
  const body = request.user.at(-1)?.text ?? "";
  const found: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^- \(\d+x\) (?<text>.+)$/u.exec(line);
    const text = match?.groups?.["text"];
    if (text !== undefined) found.push(text);
  }
  return found;
}

/** Reads the ids and cue texts back out of a rendered batch request. */
export function parseBatchRequest<T>(request: ModelRequest<T>): {
  ids: number[];
  cues: Map<number, string>;
} {
  const body = request.user.at(-1)?.text ?? "";
  const ids: number[] = [];
  const cues = new Map<number, string>();
  for (const line of body.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const id = Number(line.slice(0, tab));
    if (!Number.isInteger(id) || cues.has(id)) continue;
    ids.push(id);
    cues.set(id, line.slice(tab + 1));
  }
  return { ids, cues };
}

/**
 * A rough token estimate for the fake client only. The real client uses the
 * API's own `count_tokens`, because Claude's tokenizer differs from every
 * third-party one by 15 to 30% on non-English text (spec section 4.9).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
