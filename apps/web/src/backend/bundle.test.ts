// @vitest-environment node
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

/**
 * Two promises about what a deployed bundle contains, checked by building one.
 *
 * The development-only sign-in, checkout and demo controls talk to `/api/dev`,
 * which only the local development API serves. They are behind
 * `import.meta.env.DEV`, which Vite replaces with the literal `false` for
 * production, so the branch is dead code and the module is dropped. That is the
 * mechanism that makes them impossible to enable in a production build, and a
 * comment claiming it is not the same thing as a test proving it.
 *
 * The second promise is the one that matters most: the Anthropic key lives in
 * `.env` at the repository root, is read only by Node processes, and no
 * `VITE_`-prefixed variable carries it. Translation happens in the local API,
 * never in the browser.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));

async function productionBundle(): Promise<string> {
  // Vite decides `import.meta.env.DEV` from NODE_ENV as well as the mode, and
  // Vitest sets NODE_ENV to "test". Without this the build under test is not
  // the build that ships.
  const previous = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
  let result;
  try {
    result = await build({
      root,
      mode: "production",
      logLevel: "silent",
      build: { write: false, sourcemap: false },
    });
  } finally {
    process.env["NODE_ENV"] = previous;
  }
  const outputs = Array.isArray(result) ? result : [result];
  const chunks: string[] = [];
  for (const bundle of outputs) {
    if (!("output" in bundle)) continue;
    for (const chunk of bundle.output as Rollup.OutputChunk[]) {
      if (chunk.type === "chunk") chunks.push(chunk.code);
    }
  }
  expect(chunks.length).toBeGreaterThan(0);
  return chunks.join("\n");
}

describe("the production bundle", () => {
  it("carries no development-only route and no API key", async () => {
    const code = await productionBundle();

    // The development sign-in, verification, checkout and reset.
    expect(code).not.toContain("/api/dev");
    // The contract's own routes are of course still there.
    expect(code).toContain("/api/batches");

    // Nothing may carry the model key into a browser.
    expect(code).not.toContain("ANTHROPIC_API_KEY");
    expect(code).not.toContain("sk-ant-");
  }, 120_000);
});
