import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "evals/results/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message:
            "Use named exports; default exports are only allowed where a tool requires them.",
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    // The parser, serialiser and price function must run unchanged in a browser.
    files: ["packages/subtitles/src/**/*.ts", "packages/pricing/src/**/*.ts"],
    ignores: ["packages/subtitles/src/encoding/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "fs", "path", "os", "crypto", "iconv-lite", "chardet"],
              message:
                "These packages must stay browser-safe: no Node built-ins outside src/encoding.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "Buffer", message: "Buffer is Node-only; keep it inside src/encoding." },
        { name: "process", message: "process is Node-only; keep it out of browser-safe packages." },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "evals/src/**/*.ts", "packages/cli/src/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "no-restricted-imports": "off",
      "no-restricted-globals": "off",
    },
  },
  {
    files: ["*.js", "*.config.ts"],
    languageOptions: { globals: { ...globals.node } },
    extends: [tseslint.configs.disableTypeChecked],
    rules: { "no-restricted-syntax": "off" },
  },
  prettier,
);
