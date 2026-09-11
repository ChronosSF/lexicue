import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The workspace packages are aliased to their TypeScript sources rather than to
 * their built `dist`, so `pnpm dev` needs no build step and the app compiles the
 * same files the tests cover. Only the browser-safe entry points are reachable:
 * `@lexicue/subtitles/encoding` reads files through chardet and
 * iconv-lite and has no place in a bundle.
 */
export const workspaceAliases: Record<string, string> = {
  "@lexicue/subtitles/browser": src("../../packages/subtitles/src/browser/index.ts"),
  "@lexicue/subtitles": src("../../packages/subtitles/src/index.ts"),
  "@lexicue/pricing": src("../../packages/pricing/src/index.ts"),
  "@lexicue/harness": src("../../packages/harness/src/index.ts"),
  "@lexicue/shared": src("../../packages/shared/src/index.ts"),
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: workspaceAliases },
  server: { port: 5173, strictPort: false },
  build: { outDir: "dist", sourcemap: true },
});
