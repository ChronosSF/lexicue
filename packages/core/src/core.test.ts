import { FakeTranslationModelClient } from "@lexicue/harness";
import { FREE_BALANCE_CENTS, priceCents } from "@lexicue/pricing";
import { ApiError, ledgerBalance } from "@lexicue/shared";
import { describe, expect, it } from "vitest";
import { InMemoryFileStore, InMemoryMetadataStore, applyChanges } from "./memory.js";
import {
  FILE_RETENTION_MS,
  HISTORY_RETENTION_MS,
  emptyAccount,
  outputKey,
  uploadKey,
  walletView,
  type AccountData,
} from "./records.js";
import { ConcurrentWriteError } from "./stores.js";
import { ApiService } from "./service.js";

/**
 * The core against nothing but memory: no disk, no HTTP, no key, no clock.
 *
 * That is the point of the package. Everything asserted here is what a Lambda
 * handler over DynamoDB and S3 will do, because it is the same code; the only
 * difference in Phase 2 is which two objects are passed to the constructor.
 */

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "The lighthouse has been dark for a week.",
  "",
  "2",
  "00:00:03,400 --> 00:00:06,120",
  "- And nobody thought to call?",
  "- <i>We called.</i>",
  "",
  "3",
  "00:00:06,300 --> 00:00:08,000",
  "Then we row out at first light.",
  "",
].join("\n");

const START = Date.parse("2026-09-12T09:00:00.000Z");

interface Fixture {
  service: ApiService;
  metadata: InMemoryMetadataStore;
  files: InMemoryFileStore;
  now: () => number;
  setNow: (value: number) => void;
}

function fixture(options: { verified?: boolean } = {}): Fixture {
  const metadata = new InMemoryMetadataStore();
  const files = new InMemoryFileStore();
  let clock = START;
  let counter = 0;
  const service = new ApiService({
    metadata,
    files,
    downloads: {
      fileUrl: (jobId) => `/files/${jobId}`,
      zipUrl: (batchId) => `/files/${batchId}/zip`,
    },
    environment: {
      now: () => clock,
      newId: (prefix) => {
        counter += 1;
        return `${prefix}_${counter.toString().padStart(4, "0")}`;
      },
    },
    batchSize: 120,
    startsImmediately: true,
  });

  const seeded = emptyAccount();
  seeded.account.user = {
    userId: "usr_1",
    email: "founder@example.com",
    emailVerified: options.verified !== false,
    createdAt: START,
  };
  void metadata.commit({ account: seeded.account });

  return {
    service,
    metadata,
    files,
    now: () => clock,
    setNow: (value) => {
      clock = value;
    },
  };
}

/** Uploads one file the way the contract does: ask for a slot, send the bytes. */
async function upload(f: Fixture, fileName: string, text = SRT): Promise<string> {
  const created = await f.service.createUploads(
    { files: [{ fileName, byteLength: Buffer.byteLength(text) }] },
    f.now(),
    (id) => ({ url: `/uploads/${id}`, fields: {} }),
  );
  const uploadId = created.uploads[0]?.uploadId ?? "";
  await f.service.receiveUpload(uploadId, new TextEncoder().encode(text));
  return uploadId;
}

describe("the in-memory store", () => {
  it("replaces a row by id and keeps its position", () => {
    const data = emptyAccount();
    applyChanges(data, {
      putUploads: [
        { uploadId: "a", fileName: "a.srt", byteLength: 1, received: false, createdAt: 0 },
        { uploadId: "b", fileName: "b.srt", byteLength: 1, received: false, createdAt: 0 },
      ],
    });
    applyChanges(data, {
      putUploads: [
        { uploadId: "a", fileName: "a.srt", byteLength: 9, received: true, createdAt: 0 },
      ],
    });
    expect(data.uploads.map((u) => [u.uploadId, u.byteLength])).toEqual([
      ["a", 9],
      ["b", 1],
    ]);
  });

  it("deletes by id and appends to the ledger", () => {
    const data = emptyAccount();
    applyChanges(data, {
      putBatches: [batchRow("bat_1"), batchRow("bat_2")],
      appendLedger: [entry("led_1")],
    });
    applyChanges(data, { deleteBatchIds: ["bat_1"], appendLedger: [entry("led_2")] });
    expect(data.batches.map((b) => b.batchId)).toEqual(["bat_2"]);
    expect(data.ledger.map((e) => e.id)).toEqual(["led_1", "led_2"]);
  });

  /**
   * The condition of section 7.4's charging transaction. A commit that no
   * longer holds writes nothing at all, which is what makes the charge and the
   * rows it creates one unit rather than four.
   */
  it("refuses a commit whose balance condition no longer holds, and writes nothing", () => {
    const data = emptyAccount();
    data.account.balanceCents = 40;
    expect(() => {
      applyChanges(data, { requireBalanceAtLeast: 100, putBatches: [batchRow("bat_1")] });
    }).toThrow(ConcurrentWriteError);
    expect(data.batches).toEqual([]);
  });
});

describe("the service, over memory alone", () => {
  it("grants the free balance once per email, however often it is verified", async () => {
    const f = fixture({ verified: false });
    await f.service.verifyEmail(f.now());
    await f.service.verifyEmail(f.now());
    const me = await f.service.me(f.now());
    expect(me.balanceCents).toBe(FREE_BALANCE_CENTS);
    expect(me.freeCents).toBe(FREE_BALANCE_CENTS);
    expect(me.transactions.filter((entry) => entry.reason === "grant")).toHaveLength(1);
  });

  it("refuses an upload before the email is verified", async () => {
    const f = fixture({ verified: false });
    await expect(upload(f, "film.srt")).rejects.toMatchObject({
      body: { code: "email-not-verified" },
    });
  });

  it("charges, translates, stores the output and leaves the ledger exact", async () => {
    const f = fixture();
    await f.service.verifyEmail(f.now());
    const uploadId = await upload(f, "film.srt");

    const started = await f.service.createBatch(
      {
        uploadIds: [uploadId],
        targetLanguage: "de",
        lane: "fast",
        options: {
          formality: "auto",
          contextNote: "",
          lineHandling: "reflow",
          translateLyrics: true,
          outputBom: true,
        },
      },
      f.now(),
    );

    const price = priceCents(started.response.batch.jobs[0]?.dialogueChars ?? 0, "fast");
    expect(started.response.batch.priceCents).toBe(price);
    expect(started.response.balanceCents).toBe(FREE_BALANCE_CENTS - price);
    // The work starts in this process, so the 202 already says so.
    expect(started.response.batch.status).toBe("running");
    expect(started.work).not.toBeNull();

    if (started.work === null) throw new Error("no work");
    const outcome = await f.service.translate(started.work, new FakeTranslationModelClient());
    expect(outcome).toEqual({ done: 1, failed: 0 });

    const view = await f.service.getBatch(started.response.batch.batchId, f.now());
    expect(view.batch.status).toBe("done");
    expect(view.batch.jobs[0]?.status).toBe("done");
    expect(view.batch.jobs[0]?.report?.totalCues).toBe(3);
    expect(view.batch.jobs[0]?.downloadUrl).not.toBeNull();
    // The retention clock starts when the batch finishes, not when it started.
    expect(view.batch.filesExpireAt).toBe(new Date(f.now() + FILE_RETENTION_MS).toISOString());

    const output = await f.service.outputBytes(view.batch.jobs[0]?.jobId ?? "");
    expect(output?.fileName).toBe("film.de.srt");
    expect(new TextDecoder().decode(output?.bytes)).toContain("«");

    const data = f.metadata.snapshot();
    expect(ledgerBalance(walletView(data))).toBe(data.account.balanceCents);
  });

  it("refunds a file that fails, restoring the free portion it spent", async () => {
    const f = fixture();
    await f.service.verifyEmail(f.now());
    const doomed = new ApiService({
      metadata: f.metadata,
      files: f.files,
      downloads: { fileUrl: () => null, zipUrl: () => null },
      environment: { now: f.now, newId: (prefix) => `${prefix}_x` },
      shouldFail: () => true,
    });
    const uploadId = await upload(f, "film.srt");
    const started = await doomed.createBatch(
      {
        uploadIds: [uploadId],
        targetLanguage: "de",
        lane: "fast",
        options: {
          formality: "auto",
          contextNote: "",
          lineHandling: "reflow",
          translateLyrics: true,
          outputBom: true,
        },
      },
      f.now(),
    );

    expect(started.work).toBeNull();
    expect(started.response.balanceCents).toBe(FREE_BALANCE_CENTS);
    const data = f.metadata.snapshot();
    expect(data.account.freeCents).toBe(FREE_BALANCE_CENTS);
    expect(ledgerBalance(walletView(data))).toBe(FREE_BALANCE_CENTS);
    expect(data.ledger.map((entry) => entry.reason)).toEqual(["grant", "charge", "refund"]);
  });

  it("refuses a target language that is already the source, before any charge", async () => {
    const f = fixture();
    await f.service.verifyEmail(f.now());
    const uploadId = await upload(
      f,
      "el-faro.srt",
      ["1", "00:00:01,000 --> 00:00:03,000", "No es que no quiera, es que no puedo.", "", ""].join(
        "\n",
      ),
    );
    await expect(
      f.service.createBatch(
        {
          uploadIds: [uploadId],
          targetLanguage: "es",
          lane: "fast",
          options: {
            formality: "auto",
            contextNote: "",
            lineHandling: "reflow",
            translateLyrics: true,
            outputBom: true,
          },
        },
        f.now(),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(f.metadata.snapshot().account.balanceCents).toBe(FREE_BALANCE_CENTS);
  });

  it("refuses an upload the balance will not cover, with the shortfall", async () => {
    const f = fixture();
    const uploadId = await upload(f, "film.srt");
    await expect(
      f.service.createBatch(
        {
          uploadIds: [uploadId],
          targetLanguage: "de",
          lane: "fast",
          options: {
            formality: "auto",
            contextNote: "",
            lineHandling: "reflow",
            translateLyrics: true,
            outputBom: true,
          },
        },
        f.now(),
      ),
    ).rejects.toMatchObject({
      body: { code: "insufficient-balance", shortfallCents: 10, suggestedTopUpCents: 500 },
    });
  });

  it("credits a top-up once, however many times the webhook arrives", async () => {
    const f = fixture();
    await f.service.verifyEmail(f.now());
    const session = await f.service.topUp({ amountCents: 500 }, f.now(), (id) => `/checkout/${id}`);
    await f.service.creditCheckout(session.sessionId, f.now());
    const second = await f.service.creditCheckout(session.sessionId, f.now());
    expect(second.balanceCents).toBe(FREE_BALANCE_CENTS + 500);
    const data = f.metadata.snapshot();
    expect(data.ledger.filter((entry) => entry.reason === "topup")).toHaveLength(1);
    expect(ledgerBalance(walletView(data))).toBe(data.account.balanceCents);
  });

  it("deletes the files 24 hours after a batch finishes and keeps the history row", async () => {
    const f = fixture();
    await f.service.verifyEmail(f.now());
    const uploadId = await upload(f, "film.srt");
    const started = await f.service.createBatch(
      {
        uploadIds: [uploadId],
        targetLanguage: "de",
        lane: "fast",
        options: {
          formality: "auto",
          contextNote: "",
          lineHandling: "reflow",
          translateLyrics: true,
          outputBom: true,
        },
      },
      f.now(),
    );
    if (started.work === null) throw new Error("no work");
    await f.service.translate(started.work, new FakeTranslationModelClient());
    const jobId = started.work.jobs[0]?.jobId ?? "";
    expect(await f.files.get(outputKey(jobId))).not.toBeNull();
    expect(await f.files.get(uploadKey(uploadId))).not.toBeNull();

    f.setNow(START + FILE_RETENTION_MS + 1);
    const view = await f.service.getBatch(started.response.batch.batchId, f.now());
    expect(view.batch.jobs[0]?.downloadUrl).toBeNull();
    expect(view.batch.filesExpireAt).toBeNull();
    expect(await f.files.get(outputKey(jobId))).toBeNull();
    expect(await f.files.get(uploadKey(uploadId))).toBeNull();

    // The row itself survives for the 30 days section 3.2 keeps history for.
    f.setNow(START + HISTORY_RETENTION_MS + 1);
    await expect(f.service.getBatch(started.response.batch.batchId, f.now())).rejects.toMatchObject(
      {
        body: { code: "not-found" },
      },
    );
  });

  it("keeps the free-balance record when the account is deleted", async () => {
    const f = fixture();
    await f.service.verifyEmail(f.now());
    await f.service.deleteAccount();
    const data = f.metadata.snapshot();
    expect(data.account.grantedEmails).toEqual(["founder@example.com"]);
    expect(data.account.balanceCents).toBe(0);
    expect(f.files.size).toBe(0);
  });
});

function batchRow(batchId: string): AccountData["batches"][number] {
  return {
    batchId,
    status: "queued",
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
    priceCents: 10,
    refundedCents: 0,
    jobIds: [],
    seasonGlossary: null,
    messageBatchId: null,
    createdAt: 0,
    finishedAt: null,
    filesExpireAt: null,
    filesDeleted: false,
  };
}

function entry(id: string): AccountData["ledger"][number] {
  return {
    id,
    at: new Date(0).toISOString(),
    deltaCents: 0,
    reason: "grant",
    ref: null,
    description: "",
    balanceAfter: 0,
    freeDeltaCents: 0,
  };
}
