import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./vite.config.js";

/**
 * The web project of the root Vitest run: jsdom, React Testing Library and the
 * same workspace aliases the app is built with, so components and the mock
 * backend are tested against the real parser, price function and harness.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: workspaceAliases },
  test: {
    name: "web",
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
