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

/**
 * The local development API runs as its own process (`packages/dev-api`), and
 * `/api` is proxied to it, so the browser sees one origin exactly as it will
 * behind CloudFront (spec section 7.2) and the app's `RealBackend` is exercised
 * over a real HTTP hop. `pnpm dev` starts both; `pnpm dev:mock` starts only
 * this, with the in-browser mock backend.
 */
const apiPort = Number(process.env["LEXICUE_API_PORT"] ?? "5174");

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: { alias: workspaceAliases },
  // `vite --mode mock` is what `pnpm dev:mock` runs. A mode rather than an
  // environment variable because `VITE_BACKEND=mock vite` is not a command on
  // Windows, and an extra dependency to say so is not worth it. Every other
  // mode leaves `VITE_BACKEND` to the environment, as spec section 9.6 expects.
  ...(mode === "mock"
    ? { define: { "import.meta.env.VITE_BACKEND": JSON.stringify("mock") } }
    : {}),
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort.toString()}`,
        changeOrigin: false,
      },
    },
  },
  build: { outDir: "dist", sourcemap: true },
}));
