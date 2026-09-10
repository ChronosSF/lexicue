import { MockBackend } from "./mock/adapter.js";
import { RealBackend } from "./real.js";
import type { BackendAdapter } from "./types.js";

export type { BackendAdapter, DemoControls, SampleFile, Session } from "./types.js";
export { MockBackend } from "./mock/adapter.js";
export { RealBackend } from "./real.js";

/**
 * Which backend the build talks to (`VITE_BACKEND`). Anything but `real` is the
 * mock, so a developer who forgets the variable gets the demo rather than a
 * page of failed requests against an API that does not exist yet.
 */
export function createBackend(): BackendAdapter {
  if (import.meta.env.VITE_BACKEND === "real") {
    return new RealBackend({
      ...(import.meta.env.VITE_API_BASE_URL === undefined
        ? {}
        : { baseUrl: import.meta.env.VITE_API_BASE_URL }),
    });
  }
  return new MockBackend();
}
