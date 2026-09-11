import { describe, expect, it } from "vitest";
import { DEFAULT_HARNESS_CONFIG } from "./config.js";
import {
  DEFAULT_MODEL_CAPABILITIES,
  canCachePrefix,
  capabilitiesFor,
} from "./model-capabilities.js";

describe("the model capability table", () => {
  it("describes the product's own model as it has always behaved", () => {
    const sonnet = capabilitiesFor(DEFAULT_HARNESS_CONFIG.model);
    expect(sonnet.acceptsEffort).toBe(true);
    expect(sonnet.thinking).toBe("adaptive");
    expect(sonnet.acceptsStructuredOutputs).toBe(true);
    expect(sonnet.minimumCacheablePrefixTokens).toBe(1024);
  });

  /**
   * The three differences this table exists for. Effort is an error rather than
   * a no-op on Haiku 4.5, there is no adaptive thinking to fall back on, and the
   * cacheable minimum is four times Sonnet 5's.
   */
  it("records how Haiku 4.5 differs", () => {
    const haiku = capabilitiesFor("claude-haiku-4-5");
    expect(haiku.acceptsEffort).toBe(false);
    expect(haiku.thinking).toBe("budget-tokens");
    expect(haiku.acceptsStructuredOutputs).toBe(true);
    expect(haiku.minimumCacheablePrefixTokens).toBe(4096);
  });

  it("gives the refusal fallback model a 512-token minimum", () => {
    expect(capabilitiesFor(DEFAULT_HARNESS_CONFIG.fallbackModel)).toMatchObject({
      acceptsEffort: true,
      minimumCacheablePrefixTokens: 512,
    });
  });

  it("falls back to the default card for an id it does not know", () => {
    expect(capabilitiesFor("claude-something-unreleased")).toBe(DEFAULT_MODEL_CAPABILITIES);
  });

  it("knows which prefixes are long enough to cache on which model", () => {
    // The same 2,000-token prefix: cacheable on Sonnet 5, silently not on Haiku.
    expect(canCachePrefix("claude-sonnet-5", 2000)).toBe(true);
    expect(canCachePrefix("claude-haiku-4-5", 2000)).toBe(false);
    expect(canCachePrefix("claude-haiku-4-5", 4096)).toBe(true);
  });
});
