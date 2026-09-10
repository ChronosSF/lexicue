import type { HarnessConfig } from "./config.js";
import { ModelTransportError } from "./errors.js";
import type { TranslationModelClient } from "./model-client.js";

/**
 * Retries a call that failed with a 429, a 5xx or a dropped connection.
 *
 * The Anthropic SDK already does this — spec section 4.8 says its two automatic
 * retries are kept — so for a client that declares `retriesTransportErrors`
 * this does nothing and there is no second layer of backoff. Clients that do
 * not retry, which is every client in the tests, get the harness's own retries
 * so the 429 and 500 paths of spec section 10.2 are exercised.
 */
export async function withTransportRetry<T>(
  client: TranslationModelClient,
  config: Pick<HarnessConfig, "transportRetries">,
  call: () => Promise<T>,
): Promise<T> {
  const attempts = client.retriesTransportErrors ? 1 : config.transportRetries + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (!(error instanceof ModelTransportError) || !error.retryable) throw error;
    }
  }
  throw lastError;
}
