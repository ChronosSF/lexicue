import { DEFAULT_RATE_TABLE, type RateTable } from "@lexicue/pricing";
import type { CacheTtl, Effort } from "./model-client.js";

/**
 * Everything spec section 9.8 calls configuration. In the deployed system these
 * come from Parameter Store and are refreshed every five minutes; here they are
 * the defaults the specification states, and the command-line tool overrides
 * them from flags.
 */
export interface HarnessConfig {
  /** Pinned snapshot id (spec section 5.1). */
  model: string;
  /** Used once per cue after a `refusal` stop reason (spec section 4.6). */
  fallbackModel: string;
  /** Sonnet 5 respects effort strictly; `medium` is the spec's choice. */
  effort: Effort;
  /** Cues per batch request (spec section 4.4). */
  batchSize: number;
  /** Batches in flight per file on the fast lane (spec section 4.4). */
  concurrency: number;
  /** Output cap per request (spec section 4.8). */
  maxTokens: number;
  /** Cache breakpoint lifetime on the fast lane. */
  fastCacheTtl: CacheTtl;
  /** One hour on the economy lane, because batches start late (spec section 4.5). */
  economyCacheTtl: CacheTtl;
  /** Cues sampled from each file for the season glossary (spec section 4.4). */
  seasonSampleCues: number;
  /** Token cap on the whole season sample (spec section 4.4). */
  seasonSampleTokenCap: number;
  /** Retries per cue on a validation failure (spec section 4.6). */
  maxCueRetries: number;
  /** Retries the harness adds for clients that do not retry transport errors. */
  transportRetries: number;
  /** How often the economy poller asks whether a batch has ended. */
  economyPollIntervalMs: number;
  /** How long the poller waits before giving up (spec section 4.5: 23 hours). */
  economyMaxWaitMs: number;
  /** Reading-speed threshold for the advisory report (spec section 3.5). */
  readingSpeedCharsPerSecond: number;
  /** Line-length threshold for Latin scripts (spec section 3.5). */
  maxLineLength: number;
  /** Lines per cue before the harness re-flows (spec section 4.6). */
  maxLinesPerCue: number;
  /**
   * What each lane charges (spec section 6.1). The harness does not take money,
   * but every file report states the price the file was charged, and it has to
   * be the price the preview showed, so the table travels here as well.
   */
  rates: RateTable;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  model: "claude-sonnet-5",
  // Only ever used on the rare refusal path, where the price difference is
  // immaterial; a more capable model is the point of a fallback.
  fallbackModel: "claude-opus-5",
  effort: "medium",
  batchSize: 120,
  concurrency: 12,
  maxTokens: 16_000,
  fastCacheTtl: "5m",
  economyCacheTtl: "1h",
  seasonSampleCues: 150,
  seasonSampleTokenCap: 40_000,
  maxCueRetries: 2,
  transportRetries: 2,
  economyPollIntervalMs: 60_000,
  economyMaxWaitMs: 23 * 60 * 60 * 1000,
  readingSpeedCharsPerSecond: 20,
  maxLineLength: 42,
  maxLinesPerCue: 2,
  rates: DEFAULT_RATE_TABLE,
};

/** Applies partial overrides to the defaults. */
export function resolveConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return { ...DEFAULT_HARNESS_CONFIG, ...overrides };
}
