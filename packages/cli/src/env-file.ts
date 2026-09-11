import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/** What loading a `.env` file did. */
export interface EnvFileResult {
  /** The path that was looked for. */
  path: string;
  /** Whether a file was there. */
  found: boolean;
  /** Every key the file set, in file order. */
  loaded: string[];
  /** The keys whose value in `env` was different and got replaced. */
  overridden: string[];
}

/**
 * Reads a `.env` file into `env`. This is how the development entry points
 * find the key for this checkout without it being exported in the shell.
 *
 * A value in the file wins over one already in `env`, so a checkout always
 * uses its own key even when the shell carries one for another application;
 * the caller is told which keys that happened to, so it can say so. An empty
 * value counts as set, so an unfilled copy of `.env.example` blanks the key
 * and the tool refuses to start, rather than silently spending on whatever
 * key the shell had. A missing file is not an error; an unreadable one is.
 */
export function loadEnvFile(path: string, env: Record<string, string | undefined>): EnvFileResult {
  const result: EnvFileResult = { path, found: false, loaded: [], overridden: [] };
  if (!existsSync(path)) return result;
  result.found = true;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (value === undefined) continue;
    const current = env[key];
    if (current !== undefined && current !== value) result.overridden.push(key);
    env[key] = value;
    result.loaded.push(key);
  }
  return result;
}
