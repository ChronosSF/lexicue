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

export function resolveApiKey(env: Record<string, string | undefined>): ResolvedKey {
  const file = loadEnvFile(envFilePath(), env);
  const key = env["ANTHROPIC_API_KEY"];
  return {
    apiKey: key === undefined || key.trim() === "" ? null : key,
    overridden: file.overridden,
  };
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
