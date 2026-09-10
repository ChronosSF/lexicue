import type { Lane } from "@subtitle-translator/pricing";
import type { ModelUsage } from "./model-client.js";

/** Dollars per million tokens (spec section 5.1, verified 9 September 2026). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  /** The one-hour write is twice the base input rate. */
  cacheWrite1h: number;
  cacheRead: number;
}

/** The rate card used when a model id is not in the table. */
export const DEFAULT_MODEL_PRICE: ModelPrice = {
  input: 2,
  output: 10,
  cacheWrite5m: 2.5,
  cacheWrite1h: 4,
  cacheRead: 0.2,
};

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5": DEFAULT_MODEL_PRICE,
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.1,
  },
  "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-fable-5-1": {
    input: 10,
    output: 50,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    cacheRead: 0.25,
  },
};

/** The rate card for a model, or Sonnet 5's as the documented default. */
export function priceFor(model: string): ModelPrice {
  return MODEL_PRICES[model] ?? DEFAULT_MODEL_PRICE;
}

/**
 * What one file's model calls cost, in US dollars (spec section 5.4). The
 * Message Batches API halves every token price, which is why the economy lane
 * exists at all.
 */
export function modelCostUsd(usage: ModelUsage, model: string, lane: Lane): number {
  const price = priceFor(model);
  const discount = lane === "economy" ? 0.5 : 1;
  const perMillion =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadInputTokens * price.cacheRead +
    write5m(usage) * price.cacheWrite5m +
    usage.cacheCreation1hInputTokens * price.cacheWrite1h;
  return (perMillion / 1_000_000) * discount;
}

/** A breakdown for the report, in the shape of the table in spec section 5.4. */
export interface CostBreakdown {
  cacheWriteUsd: number;
  cacheReadUsd: number;
  uncachedInputUsd: number;
  outputUsd: number;
  totalUsd: number;
}

export function costBreakdown(usage: ModelUsage, model: string, lane: Lane): CostBreakdown {
  const price = priceFor(model);
  const discount = lane === "economy" ? 0.5 : 1;
  const scale = discount / 1_000_000;
  const cacheWriteUsd =
    (write5m(usage) * price.cacheWrite5m + usage.cacheCreation1hInputTokens * price.cacheWrite1h) *
    scale;
  const cacheReadUsd = usage.cacheReadInputTokens * price.cacheRead * scale;
  const uncachedInputUsd = usage.inputTokens * price.input * scale;
  const outputUsd = usage.outputTokens * price.output * scale;
  return {
    cacheWriteUsd,
    cacheReadUsd,
    uncachedInputUsd,
    outputUsd,
    totalUsd: cacheWriteUsd + cacheReadUsd + uncachedInputUsd + outputUsd,
  };
}

/** Renders a model cost the way the reports and the command line print it. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

/**
 * Five-minute cache writes. Responses report the per-TTL split when they can;
 * where only the total is known, everything is treated as a five-minute write,
 * which is the cheaper of the two and therefore never overstates the bill.
 */
function write5m(usage: ModelUsage): number {
  const split = usage.cacheCreation5mInputTokens + usage.cacheCreation1hInputTokens;
  if (split > 0) return usage.cacheCreation5mInputTokens;
  return usage.cacheCreationInputTokens;
}
