import { createDevExtras } from "./dev.js";
import { MockBackend } from "./mock/adapter.js";
import { RealBackend, type RealBackendOptions } from "./real.js";
import type { BackendAdapter } from "./types.js";

export type { BackendAdapter, DemoControls, SampleFile, Session } from "./types.js";
export { MockBackend } from "./mock/adapter.js";
export { RealBackend } from "./real.js";

/**
 * Which backend the build talks to.
 *
 * `VITE_BACKEND=mock` runs the whole product in the browser with a fake model
 * and no network at all. Anything else talks to `/api/*`, which in development
 * is the local API of `packages/dev-api` — real files, real wallet arithmetic,
 * real translation by Claude — and in a deployed build will be the Lambda
 * handlers of spec section 7.2 behind a Cognito token.
 *
 * The development-only sign-in, checkout and demo controls sit behind
 * `import.meta.env.DEV`, which Vite replaces with the literal `false` when it
 * builds for production. The branch is then dead code, `createDevExtras` has no
 * live caller, and `./dev.js` is dropped from the bundle: `bundle.test.ts`
 * builds the app and asserts no `/api/dev` route survives.
 */
export function createBackend(): BackendAdapter {
  if (import.meta.env.VITE_BACKEND === "mock") return new MockBackend();

  const baseUrl = import.meta.env.VITE_API_BASE_URL;
  const options: RealBackendOptions = {};
  if (baseUrl !== undefined) options.baseUrl = baseUrl;
  // A plain `if` and not a conditional spread: with `import.meta.env.DEV`
  // replaced by `false`, this whole statement is unreachable, `createDevExtras`
  // loses its only caller, and `./dev.js` leaves the graph.
  if (import.meta.env.DEV) options.dev = createDevExtras(baseUrl ?? "");
  return new RealBackend(options);
}
