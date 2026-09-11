import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Two projects, one command. The packages and the eval runner are Node code;
 * the web app is jsdom with React Testing Library and brings its own config.
 * Both resolve the workspace packages to their TypeScript sources, so `pnpm
 * test` never depends on a build and coverage is reported against the files
 * under review.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            "@subtitle-translator/subtitles/encoding": src(
              "./packages/subtitles/src/encoding/index.ts",
            ),
            "@subtitle-translator/subtitles/browser": src(
              "./packages/subtitles/src/browser/index.ts",
            ),
            "@subtitle-translator/subtitles": src("./packages/subtitles/src/index.ts"),
            "@subtitle-translator/pricing": src("./packages/pricing/src/index.ts"),
            "@subtitle-translator/harness": src("./packages/harness/src/index.ts"),
            "@subtitle-translator/cli": src("./packages/cli/src/index.ts"),
            "@subtitle-translator/shared": src("./packages/shared/src/index.ts"),
          },
        },
        test: {
          name: "packages",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "evals/src/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
      "./apps/web/vitest.config.ts",
    ],
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
