#!/usr/bin/env node
import { AnthropicTranslationClient } from "@lexicue/harness";
import { DEFAULT_API_PORT, missingKeyMessage, resolveApiKey } from "./env.js";
import { createDevApi } from "./server.js";

/**
 * The local development API, on its own port, with Vite proxying `/api` to it.
 * It is a separate process rather than a Vite plugin for three reasons, spelled
 * out in `apps/web/README.md`: the workspace is consumed as TypeScript source
 * through `tsx`, as `pnpm harness` and `pnpm evals` already are; a real HTTP
 * hop is what exercises the app's `RealBackend`; and a translation that takes a
 * minute is not interrupted when the front end hot-reloads.
 */

const { apiKey, overridden } = resolveApiKey(process.env);
if (apiKey === null) {
  process.stderr.write(`${missingKeyMessage()}\n`);
  process.exit(1);
}
for (const key of overridden) {
  process.stderr.write(`${key} from .env overrides the value in the environment.\n`);
}

const portFromEnv = Number(process.env["LEXICUE_API_PORT"] ?? "");
const port = Number.isInteger(portFromEnv) && portFromEnv > 0 ? portFromEnv : DEFAULT_API_PORT;

const api = createDevApi({ client: new AnthropicTranslationClient({ apiKey }) });
await api.listen(port);

process.stdout.write(
  `Lexicue development API on http://localhost:${port.toString()}\n` +
    `  translating with claude-sonnet-5; uploads and outputs under ${api.store.dir}\n` +
    `  money is simulated: top-ups credit the balance with no card and no Stripe\n`,
);
