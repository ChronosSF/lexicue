import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { BackendProvider } from "../app/backend.js";
import { DraftProvider } from "../app/draft.js";
import type { BackendAdapter } from "../backend/types.js";

/**
 * The providers every screen sits inside. Retries are off and there is no cache
 * between tests, so a component test fails on the first wrong answer instead of
 * quietly retrying into a pass.
 */
export function renderWithBackend(
  ui: React.ReactNode,
  backend: BackendAdapter,
): RenderResult & { queryClient: QueryClient } {
  // No retries, so a component test fails on the first wrong answer instead of
  // quietly retrying into a pass. The cache is per render, so nothing leaks
  // between tests.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <BackendProvider backend={backend}>
        <DraftProvider>{ui}</DraftProvider>
      </BackendProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}
