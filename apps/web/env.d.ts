/// <reference types="vite/client" />

/**
 * The one build-time switch the app has (spec section 9.6 keeps everything else
 * in a `config.json` the deployment writes). `mock` runs the whole product in
 * the browser; `real` talks to `/api/*` with a Cognito token.
 */
interface ImportMetaEnv {
  readonly VITE_BACKEND?: "mock" | "real";
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
