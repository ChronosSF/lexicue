import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against TypeScript sources, so `pnpm test` never depends on a build
    // and coverage is reported against the files under review.
    alias: {
      "@subtitle-translator/subtitles/encoding": src("./packages/subtitles/src/encoding/index.ts"),
      "@subtitle-translator/subtitles/browser": src("./packages/subtitles/src/browser/index.ts"),
      "@subtitle-translator/subtitles": src("./packages/subtitles/src/index.ts"),
      "@subtitle-translator/pricing": src("./packages/pricing/src/index.ts"),
      "@subtitle-translator/harness": src("./packages/harness/src/index.ts"),
      "@subtitle-translator/shared": src("./packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "evals/src/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["packages/*/src/**/*.ts", "evals/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "**/bin.ts", "**/__fixtures__/**"],
      thresholds: {
        "packages/subtitles/src/**": {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        "packages/pricing/src/**": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
