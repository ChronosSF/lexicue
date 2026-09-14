import type { Batch, Job, MeResponse } from "@lexicue/shared";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keys, useMe } from "../../app/queries.js";
import type { BackendAdapter } from "../../backend/types.js";
import { renderWithBackend } from "../../testing/render.js";
import { AppHeader } from "../../ui/AppHeader.js";
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

/**
 * The refund of spec section 2.3 lands inside the backend while this screen is
 * only polling the batch, and the header's balance is a query of its own. The
 * row used to say the file was refunded while the pill, one screen up, still
 * showed the charge; it caught up only on a reload or a visit to the wallet.
 * The header is rendered here as `App` wires it, so what the pill shows is what
 * the user sees.
 */

const REFUND_SENTENCE =
  "This file could not be translated, so it was refunded to your balance. Nothing else in the upload was affected.";

function jobWith(overrides: Partial<Job>): Job {
  return {
    jobId: "job_1",
    batchId: "bat_1",
    fileName: "fail.srt",
    outputFileName: "fail.de.srt",
    status: "running",
    lane: "fast",
    format: "srt",
    encoding: "utf-8",
    cueCount: 38,
    dialogueChars: 1_062,
    runningTimeMs: 120_000,
    priceCents: 10,
    refundedCents: 0,
    sourceLanguage: null,
    batchesTotal: 1,
    batchesDone: 0,
    downloadUrl: null,
    report: null,
    error: null,
    createdAt: "2026-09-11T12:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

const refundedJob = jobWith({
  status: "failed",
  refundedCents: 10,
  error: REFUND_SENTENCE,
  finishedAt: "2026-09-11T12:00:02.000Z",
});

function meWith(balanceCents: number): MeResponse {
  return {
    user: {
      userId: "usr_1",
      email: "viewer@example.com",
      emailVerified: true,
      createdAt: "2026-09-11T11:00:00.000Z",
    },
    balanceCents,
    freeCents: 0,
    limits: {
      maxFilesPerUpload: 50,
      maxUploadBytes: 100_000_000,
      maxFileBytes: 10_000_000,
      maxCuesPerFile: 10_000,
      concurrentFastFiles: 3,
      maxFilesPerDay: 100,
      filesRunning: 0,
      filesToday: 0,
    },
    recentBatches: [],
    transactions: [],
  };
}

/** The item at `index`, or the last one once the list has run out. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[Math.min(index, items.length - 1)];
  if (item === undefined) throw new Error("nothing left to answer with");
  return item;
}

/**
 * A backend that answers each poll with the next snapshot and then holds the
 * last, and answers the wallet the same way — the balance after the charge,
 * then the balance after the refund — counting how often each is asked.
 */
function backendPlaying(
  snapshots: readonly Batch[],
  balances: readonly number[],
): { backend: BackendAdapter; asked: { batch: number; me: number } } {
  const asked = { batch: 0, me: 0 };
  const backend = {
    kind: "real",
    demo: null,
    getBatch: () => {
      const batch = nth(snapshots, asked.batch);
      asked.batch += 1;
      return Promise.resolve({ batch });
    },
    getMe: () => {
      const me = meWith(nth(balances, asked.me));
      asked.me += 1;
      return Promise.resolve(me);
    },
  } as unknown as BackendAdapter;
  return { backend, asked };
}

/** The header as `App` wires it: the balance pill reading the wallet query. */
function Header(): React.JSX.Element {
  const me = useMe();
  return (
    <AppHeader
      balance={
        me.data === undefined
          ? null
          : { balanceCents: me.data.balanceCents, freeCents: me.data.freeCents }
      }
      menuItems={[]}
    />
  );
}

function renderUnderHeader(backend: BackendAdapter) {
  return renderWithBackend(
    <>
      <Header />
      <BatchScreen batchId="bat_1" />
    </>,
    backend,
  );
}

describe("the header balance", () => {
  const running = batchWith({ jobs: [jobWith({})], pollAfterMs: 20 });
  const refunded = batchWith({
    status: "failed",
    failedCount: 1,
    refundedCents: 10,
    jobs: [refundedJob],
    pollAfterMs: 20,
    finishedAt: "2026-09-11T12:00:02.000Z",
    filesExpireAt: "2026-09-12T12:00:02.000Z",
  });

  it("asks the wallet again when a poll shows the file refunded, so the pill agrees with the row", async () => {
    const { backend, asked } = backendPlaying([running, refunded], [240, 250]);
    const { queryClient } = renderUnderHeader(backend);
    // The history list sits in the cache, unobserved, while this screen is up.
    queryClient.setQueryData(keys.batches, []);

    // After the charge and before the refund, the pill shows the charged balance.
    expect(await screen.findByText("$2.40")).toBeInTheDocument();

    // Then the row says the file was refunded, and the header agrees with it —
    // on this screen, without a reload.
    expect(await screen.findByText(REFUND_SENTENCE)).toBeInTheDocument();
    expect(await screen.findByText("$2.50")).toBeInTheDocument();
    expect(asked.me).toBe(2);

    // The history row changed too, so the list is stale for its next visit.
    expect(queryClient.getQueryState(keys.batches)?.isInvalidated).toBe(true);
  });

  it("asks once when a refund lands mid-batch, and does not poll the wallet after it", async () => {
    const second = jobWith({
      jobId: "job_2",
      fileName: "s01e02.srt",
      outputFileName: "s01e02.de.srt",
    });
    const twoFiles = { fileCount: 2, priceCents: 20, pollAfterMs: 20 };
    const before = batchWith({ ...twoFiles, jobs: [jobWith({}), second] });
    const after = batchWith({
      ...twoFiles,
      failedCount: 1,
      refundedCents: 10,
      jobs: [refundedJob, second],
    });
    const { backend, asked } = backendPlaying([before, after], [230, 240]);
    renderUnderHeader(backend);

    expect(await screen.findByText("$2.30")).toBeInTheDocument();
    expect(await screen.findByText("$2.40")).toBeInTheDocument();

    // The other file is still translating, so the batch goes on being polled...
    expect(screen.getByRole("heading", { name: /Translating 2 files/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(asked.batch).toBeGreaterThan(4);
    });
    // ...while the wallet was asked once, for the refund, and not once per poll.
    expect(asked.me).toBe(2);
  });

  it("does not ask the wallet about a batch that was already closed when it was opened", async () => {
    const { backend, asked } = backendPlaying([refunded], [250]);
    renderUnderHeader(backend);

    expect(await screen.findByText(REFUND_SENTENCE)).toBeInTheDocument();
    expect(await screen.findByText("$2.50")).toBeInTheDocument();
    expect(asked.me).toBe(1);
  });
});
