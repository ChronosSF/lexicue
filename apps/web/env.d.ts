/// <reference types="vite/client" />

/**
 * The one build-time switch the app has (spec section 9.6 keeps everything else
 * in a `config.json` the deployment writes). `mock` runs the whole product in
 * the browser with a fake model; anything else talks to `/api/*` — the local
 * development API under `pnpm dev`, and the deployed handlers with a Cognito
 * token in Phase 2.
 */
interface ImportMetaEnv {
  readonly VITE_BACKEND?: "mock" | "real";
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
