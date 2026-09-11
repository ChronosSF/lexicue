/**
 * What a model's request surface accepts, so the client builds a request from a
 * table rather than from string checks scattered through the code.
 *
 * Only the fields that actually differ between the models this harness runs on
 * are here. Everything else about a request — the cache breakpoints, the
 * structured-output schema, the absence of sampling parameters and of a prefill
 * — is identical on every model, which is what keeps the rest of the harness
 * model-agnostic.
 *
 * Checked against the Claude API documentation and the installed SDK's type
 * definitions on 11 September 2026.
 */
export interface ModelCapabilities {
  /**
   * `output_config.effort`. Haiku 4.5 rejects the field outright rather than
   * ignoring it, so a request that carries it fails instead of running at some
   * default effort.
   */
  acceptsEffort: boolean;
  /**
   * How the model is asked to think. An `adaptive` model thinks by itself when
   * `thinking` is omitted, which is what every request here does. A
   * `budget-tokens` model has no adaptive mode: omitting `thinking` means it
   * does not think at all, and the only way to make it think is an explicit
   * `{type: "enabled", budget_tokens: N}`, which the harness never sends. So a
   * `budget-tokens` model always runs without thinking here — deliberately,
   * because that is its cheap configuration and the reason to reach for it.
   */
  thinking: "adaptive" | "budget-tokens";
  /**
   * `output_config.format`, which is how the harness gets JSON it can trust
   * instead of parsing prose. Every model in the table below supports it, so
   * the batch pass needs no plain-JSON fallback path.
   */
  acceptsStructuredOutputs: boolean;
  /**
   * The shortest prefix the model will cache, in tokens. A prefix shorter than
   * this is silently not cached: no error, no write and no read, whatever
   * `cache_control` says. The minimum is not monotonic across generations —
   * Haiku 4.5 asks for four times as many tokens as Sonnet 5 — so a file short
   * enough to cache on one model can be uncacheable on a cheaper one.
   */
  minimumCacheablePrefixTokens: number;
}

/** Sonnet 5's surface, used for a model id the table does not know. */
export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  acceptsEffort: true,
  thinking: "adaptive",
  acceptsStructuredOutputs: true,
  minimumCacheablePrefixTokens: 1024,
};

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "claude-sonnet-5": DEFAULT_MODEL_CAPABILITIES,
  "claude-opus-5": {
    acceptsEffort: true,
    thinking: "adaptive",
    acceptsStructuredOutputs: true,
    minimumCacheablePrefixTokens: 512,
  },
  "claude-haiku-4-5": {
    // The three differences that matter, and the reason this table exists.
    acceptsEffort: false,
    thinking: "budget-tokens",
    acceptsStructuredOutputs: true,
    minimumCacheablePrefixTokens: 4096,
  },
};

/**
 * The capabilities of a model id, falling back to Sonnet 5's the way
 * {@link priceFor} falls back to Sonnet 5's rate card. An unknown id is
 * therefore assumed to be a current mid-tier model; add it to the table above
 * before running it in anger.
 */
export function capabilitiesFor(model: string): ModelCapabilities {
  return MODEL_CAPABILITIES[model] ?? DEFAULT_MODEL_CAPABILITIES;
}

/**
 * Whether a prefix of this many tokens can be cached at all on this model.
 * Used to keep the cache warning quiet where a miss is arithmetic rather than
 * a bug.
 */
export function canCachePrefix(model: string, prefixTokens: number): boolean {
  return prefixTokens >= capabilitiesFor(model).minimumCacheablePrefixTokens;
}
