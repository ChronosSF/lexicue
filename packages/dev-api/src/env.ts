import { fileURLToPath } from "node:url";
import { loadEnvFile } from "@lexicue/cli";

/**
 * The key, read the way spec section 9.9 and the command-line tool read it:
 * from `.env` at the repository root, where a value wins over one exported in
 * the shell, falling back to the environment when there is no file. It is the
 * same `loadEnvFile` the command-line tool and the eval runner call, because
 * two parsers of the same file would eventually disagree.
 *
 * Nothing here ever prints the key, and nothing prefixed `VITE_` ever sees it:
 * translation runs in this Node process and the browser talks to it over HTTP.
 */

export const DEFAULT_API_PORT = 5174;

/** The path of `.env` at the repository root. */
export function envFilePath(): string {
  return fileURLToPath(new URL("../../../.env", import.meta.url));
}

export interface ResolvedKey {
  apiKey: string | null;
  /** Keys the file replaced in the environment, so the caller can say so. */
  overridden: string[];
}

export function resolveApiKey(
  env: Record<string, string | undefined>,
  path: string = envFilePath(),
): ResolvedKey {
  const file = loadEnvFile(path, env);
  const key = env["ANTHROPIC_API_KEY"];
  return {
    apiKey: key === undefined || key.trim() === "" ? null : key,
    overridden: file.overridden,
  };
}

/**
 * Stripe, if there is anything to be Stripe with (spec section 6.6).
 *
 * Both values are read from the same `.env` as the model key, and **neither is
 * ever printed, logged or returned** — only whether it is there. Absent, the
 * billing webhook route refuses with a sentence naming what to set, which is
 * the honest state of this repository: there is no Stripe account and nothing
 * in `packages/core/src/billing.ts` has ever talked to one.
 */
export interface ResolvedStripe {
  secretKey: string | null;
  webhookSecret: string | null;
  /** True when both are set, which is the only configuration that works. */
  configured: boolean;
}

export function resolveStripe(
  env: Record<string, string | undefined>,
  path: string = envFilePath(),
): ResolvedStripe {
  loadEnvFile(path, env);
  const value = (name: string): string | null => {
    const raw = env[name];
    return raw === undefined || raw.trim() === "" ? null : raw;
  };
  const secretKey = value("STRIPE_SECRET_KEY");
  const webhookSecret = value("STRIPE_WEBHOOK_SECRET");
  return { secretKey, webhookSecret, configured: secretKey !== null && webhookSecret !== null };
}

/** What the webhook route answers when there is no Stripe to verify against. */
export function missingStripeMessage(): string {
  return [
    "Stripe is not configured, so this webhook cannot be verified and nothing was credited.",
    "Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in .env at the repository root",
    "and restart the API. Both must be test-mode values.",
  ].join(" ");
}

/** What `pnpm dev` prints instead of quietly falling back to the mock. */
export function missingKeyMessage(): string {
  return [
    "No ANTHROPIC_API_KEY, so the local API cannot translate anything.",
    "",
    `Copy .env.example to .env at the repository root and paste the key after the`,
    `equals sign (looked for it in ${envFilePath()}).`,
    "",
    "To click through the product without a key, run `pnpm dev:mock` instead: the",
    "mock backend runs the whole flow in the browser with a fake model.",
  ].join("\n");
}
