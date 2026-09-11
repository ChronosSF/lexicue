import type { Batch } from "@lexicue/shared";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BackendAdapter } from "../../backend/types.js";
import { renderWithBackend } from "../../testing/render.js";
import { BatchScreen } from "./BatchScreen.js";

/**
 * A batch that has not finished has no `filesExpireAt` yet, and neither does one
 * whose files have been deleted. The screen used to read the first as the
 * second and tell the user their files were gone while they were still being
 * written — which the local development API made obvious, because a real
 * translation takes half a minute rather than the mock's two seconds.
 */

function batchWith(overrides: Partial<Batch>): Batch {
  return {
    batchId: "bat_1",
    status: "running",
    lane: "fast",
    targetLanguage: "de",
    targetLanguageName: "German",
    options: {
      formality: "auto",
      contextNote: "",
      lineHandling: "reflow",
      translateLyrics: true,
      outputBom: true,
    },
    fileCount: 1,
    doneCount: 0,
    failedCount: 0,
    priceCents: 10,
    refundedCents: 0,
    jobs: [],
    seasonGlossary: null,
    zipUrl: null,
    zipFileName: null,
    notice: null,
    pollAfterMs: 2_000,
    createdAt: "2026-09-11T12:00:00.000Z",
    finishedAt: null,
    filesExpireAt: null,
    ...overrides,
  };
}

function backendReturning(batch: Batch): BackendAdapter {
  return {
    kind: "real",
    demo: null,
    getBatch: () => Promise.resolve({ batch }),
  } as unknown as BackendAdapter;
}

describe("the deletion notice", () => {
  it("says nothing about deletion while the batch is still running", async () => {
    renderWithBackend(<BatchScreen batchId="bat_1" />, backendReturning(batchWith({})));
    await waitFor(() => {
      expect(screen.getByText(/Charged/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/have been deleted/)).not.toBeInTheDocument();
  });

  it("says nothing while an economy batch is still submitted", async () => {
    renderWithBackend(
      <BatchScreen batchId="bat_1" />,
      backendReturning(batchWith({ status: "submitted", lane: "economy" })),
    );
    await waitFor(() => {
      expect(screen.getByText(/Charged/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/have been deleted/)).not.toBeInTheDocument();
  });

  it("says so once a finished batch has had its files removed", async () => {
    renderWithBackend(
      <BatchScreen batchId="bat_1" />,
      backendReturning(
        batchWith({
          status: "done",
          doneCount: 1,
          finishedAt: "2026-09-11T12:01:00.000Z",
          filesExpireAt: null,
        }),
      ),
    );
    expect(await screen.findByText(/have been deleted/)).toBeInTheDocument();
  });
});
