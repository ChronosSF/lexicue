import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { missingKeyMessage, resolveApiKey } from "./env.js";

/**
 * The key is read exactly as the command-line tool reads it, through the same
 * `loadEnvFile`: the file wins over the shell, an empty value counts as unset,
 * and a missing key stops `pnpm dev` with a sentence naming `.env.example`
 * rather than quietly falling back to the mock.
 *
 * No test here ever writes a real key anywhere near a real `.env`.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lexicue-env-"));
  dirs.push(dir);
  const path = join(dir, ".env");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("reading the key", () => {
  it("takes the file's value over one exported in the shell", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "from-the-shell" };
    const resolved = resolveApiKey(env, envFile("ANTHROPIC_API_KEY=from-the-file\n"));
    expect(resolved.apiKey).toBe("from-the-file");
    expect(resolved.overridden).toContain("ANTHROPIC_API_KEY");
  });

  it("treats an empty value in the file as no key at all", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "from-the-shell" };
    expect(resolveApiKey(env, envFile("ANTHROPIC_API_KEY=\n")).apiKey).toBeNull();
  });

  it("falls back to the environment when there is no file", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "from-the-shell" };
    const resolved = resolveApiKey(env, join(tmpdir(), "lexicue-no-such-file", ".env"));
    expect(resolved.apiKey).toBe("from-the-shell");
    expect(resolved.overridden).toEqual([]);
  });

  it("reports no key rather than an empty string", () => {
    expect(resolveApiKey({}, envFile("# nothing here\n")).apiKey).toBeNull();
    expect(resolveApiKey({ ANTHROPIC_API_KEY: "   " }, envFile("")).apiKey).toBeNull();
  });
});

describe("the message when there is no key", () => {
  it("names .env.example and the way to run without a key", () => {
    const message = missingKeyMessage();
    expect(message).toContain(".env.example");
    expect(message).toContain("pnpm dev:mock");
    expect(message).toContain("ANTHROPIC_API_KEY");
  });
});
