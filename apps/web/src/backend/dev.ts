import { ApiError } from "@lexicue/shared";
import type { DemoControls, SampleFile, Session } from "./types.js";
import { TOKEN_KEY, readClaims, type RealBackendExtras } from "./real.js";

/**
 * What stands in for Cognito and for Stripe while the local development API is
 * the backend (`packages/dev-api`). Every route it calls lives under
 * `/api/dev`, which that server only serves because `pnpm dev` starts it;
 * nothing deployed has those routes at all.
 *
 * This module is reachable only from the `import.meta.env.DEV` branch of
 * `createBackend`. Vite replaces `import.meta.env.DEV` with `false` in a
 * production build, so the branch is dead code, the import is unused, and none
 * of this reaches a deployed bundle. The test in `backend/bundle.test.ts`
 * asserts the production build contains no `/api/dev` string.
 */

export function createDevExtras(baseUrl = ""): RealBackendExtras {
  const post = async (path: string): Promise<Response> => {
    const token = globalThis.sessionStorage.getItem(TOKEN_KEY);
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw await toError(response);
    return response;
  };

  const store = (token: string): Session => {
    globalThis.sessionStorage.setItem(TOKEN_KEY, token);
    const claims = readClaims(token);
    if (claims === null) {
      throw new ApiError({ code: "internal", message: "The development API returned no session." });
    }
    return {
      userId: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified,
    };
  };

  const demo: DemoControls = {
    listSamples: async () => {
      const response = await fetch("/samples/samples.json");
      if (!response.ok) throw new Error("The sample list could not be loaded.");
      return (await response.json()) as SampleFile[];
    },
    loadSample: async (path: string) => {
      const response = await fetch(`/samples/${path}`);
      if (!response.ok) throw new Error(`The sample ${path} could not be loaded.`);
      return {
        fileName: path.split("/").pop() ?? path,
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },
    reset: async () => {
      await fetch(`${baseUrl}/api/dev/reset`, { method: "POST" });
      globalThis.sessionStorage.removeItem(TOKEN_KEY);
    },
  };

  return {
    async signIn(input: { email: string }): Promise<Session> {
      const response = await fetch(`${baseUrl}/api/dev/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: input.email }),
      });
      if (!response.ok) throw await toError(response);
      return store(((await response.json()) as { token: string }).token);
    },

    /**
     * Verification reissues the token, because the claim the browser reads is
     * on it — which is what Cognito does after the link in the email is
     * followed.
     */
    async verifyEmail(): Promise<Session> {
      const response = await post("/api/dev/verify");
      return store(((await response.json()) as { token: string }).token);
    },

    /** The webhook Stripe would send; the local API has no card and no Stripe. */
    async completeCheckout(sessionId: string): Promise<void> {
      await post(`/api/dev/checkout/${sessionId}`);
    },

    demo,
  };
}

async function toError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (typeof body.error?.message === "string") {
      return new ApiError({ code: "bad-request", message: body.error.message });
    }
  } catch {
    // A response that is not the contract's error shape falls through.
  }
  return new ApiError({
    code: "internal",
    message: "The local development API did not answer. Is `pnpm dev` still running?",
  });
}
