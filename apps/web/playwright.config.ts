import { defineConfig, devices } from "@playwright/test";

/**
 * The end-to-end suite of spec section 10.3, against the mock backend.
 *
 * Section 10.3 runs Playwright against staging after every deploy; nothing is
 * deployed yet, so the subject here is `pnpm dev:mock` — the whole product in
 * the browser, with the harness driven by its deterministic fake model. That
 * costs nothing, needs no key and touches no network, and it still exercises
 * the parser, the price function, the wallet arithmetic, the refund and the
 * structural guarantee, which is what the smoke test is actually asserting.
 *
 * **A production build served by `vite preview`, not the dev server.** The one
 * build-time switch the app has is `VITE_BACKEND`, and `vite build --mode mock`
 * bakes the mock in exactly as `vite --mode mock` does for development (see
 * `vite.config.ts`), so the mock costs nothing at build time either. The suite
 * therefore runs against minified, bundled, production React — the artefact
 * that would ship — rather than against a dev server's unbundled modules and
 * development-only warnings. It is slower to start by one build and closer to
 * the truth for every second after that.
 *
 * The port is this suite's own, and `strictPort` keeps it that way: a
 * development server already on 5173 or 5174 is never borrowed, never bound and
 * never confused for this one. `reuseExistingServer` is off for the same
 * reason — the suite serves the build it just made or it fails.
 */

const PORT = 4183;
const BASE_URL = `http://127.0.0.1:${PORT.toString()}`;

export default defineConfig({
  testDir: "./e2e",
  // A suffix of its own, so neither Vitest project can pick these up: the
  // packages project takes `packages/*/src/**/*.test.ts` and the web project
  // `src/**/*.test.{ts,tsx}`.
  testMatch: "**/*.e2e.ts",

  // The mock's clock runs in seconds (`DEFAULT_TIMING` in
  // `src/backend/mock/state.ts`): about four seconds for an episode on the fast
  // lane, twelve for an economy-lane batch. Nothing here should need a minute.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  // Every test brings its own browser context, so its own `localStorage` and
  // its own demo state; they share only a static file server, and running them
  // at once is safe. A runner has two cores to give them; a laptop decides for
  // itself, which is what leaving `workers` unset means.
  ...(process.env["CI"] === undefined ? {} : { workers: 2 }),

  // The list reporter is what a person reads while it runs; the HTML report is
  // what CI uploads when something fails, with the trace of the retry in it.
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // `e2e:serve` in package.json: the mock build, then `vite preview` on the
    // port below. The two have to agree, and `strictPort` means a disagreement
    // times out here rather than quietly serving something else.
    command: "pnpm run e2e:serve",
    url: BASE_URL,
    // Never borrow a server somebody else started: this one serves the build
    // this run made, on a port nothing else in the repository uses.
    reuseExistingServer: false,
    // A cold production build of the app plus the preview server.
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
