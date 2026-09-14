import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { priceCents } from "@lexicue/pricing";
import { ApiError, DEFAULT_TRANSLATION_OPTIONS } from "@lexicue/shared";
import { parseSubtitleText } from "@lexicue/subtitles";
import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend, type MockBackendOptions } from "./adapter.js";
import { bytesToBase64 } from "./bytes.js";
import { DEMO_EMAIL } from "./seed.js";

/**
 * The mock backend is the demo's whole server, so these are the tests that
 * would otherwise be handler tests: the charging transaction, free money before
 * paid money, the 402 with its shortfall, the automatic refund, the progress
 * state machine and the zip.
 */

/** The sample files the demo ships, read straight off disk. */
const SAMPLES = [
  resolve(process.cwd(), "public/samples"),
  resolve(process.cwd(), "apps/web/public/samples"),
].find((candidate) => existsSync(candidate));

function sample(path: string): Uint8Array {
  if (SAMPLES === undefined) throw new Error("the sample files are missing");
  return new Uint8Array(readFileSync(resolve(SAMPLES, path)));
}

const START = Date.parse("2026-09-10T12:00:00.000Z");

interface Harness {
  backend: MockBackend;
  advance: (ms: number) => void;
  upload: (paths: string[]) => Promise<string[]>;
  uploadBytes: (files: { fileName: string; bytes: Uint8Array }[]) => Promise<string[]>;
}

/**
 * A file with more dialogue than the free balance covers. At 154 characters per
 * cue, 1,500 cues is $3.51 on the fast lane against the $2.50 grant.
 */
function bigSubtitleFile(cues: number): Uint8Array {
  const line = "A long line of dialogue that carries a great many billable characters indeed.";
  const blocks = Array.from({ length: cues }, (_unused, index) => {
    const start = index * 4;
    // Hours as well as minutes: past 900 cues this file runs over an hour, and
    // a "00:60:00,000" timing is not a timing — the parser drops the cue and
    // the file quietly stops being big enough to test what it is here to test.
    const stamp = (seconds: number): string => {
      const hours = Math.floor(seconds / 3600)
        .toString()
        .padStart(2, "0");
      const minutes = Math.floor((seconds % 3600) / 60)
        .toString()
        .padStart(2, "0");
      const rest = (seconds % 60).toString().padStart(2, "0");
      return `${hours}:${minutes}:${rest},000`;
    };
    return [(index + 1).toString(), `${stamp(start)} --> ${stamp(start + 3)}`, line, line].join(
      "\n",
    );
  });
  return new TextEncoder().encode(`${blocks.join("\n\n")}\n`);
}

function harness(options: Partial<MockBackendOptions> = {}): Harness {
  let clock = START;
  const backend = new MockBackend({
    now: () => clock,
    seedDemo: false,
    loadSample: (path) => Promise.resolve(sample(path)),
    loadSampleList: () => Promise.resolve([]),
    // Object URLs need a real browser; a data URL carries the same bytes.
    createDownloadUrl: (bytes, mime) => `data:${mime};base64,${bytesToBase64(bytes)}`,
    timing: {
      fastBaseMs: 1_000,
      fastPerCharMs: 0,
      fastMaxMs: 1_000,
      fastConcurrency: 3,
      economyMs: 2_000,
      checkoutSettleMs: 100,
    },
    ...options,
  });

  const uploadBytes = async (
    files: { fileName: string; bytes: Uint8Array }[],
  ): Promise<string[]> => {
    const created = await backend.createUploads({
      files: files.map((file) => ({ fileName: file.fileName, byteLength: file.bytes.length })),
    });
    await Promise.all(
      created.uploads.map((target, index) =>
        backend.putUpload(target, files[index]?.bytes ?? new Uint8Array()),
      ),
    );
    return created.uploads.map((target) => target.uploadId);
  };

  return {
    backend,
    advance: (ms) => {
      clock += ms;
    },
    upload: (paths) =>
      uploadBytes(
        paths.map((path) => ({ fileName: path.split("/").pop() ?? path, bytes: sample(path) })),
      ),
    uploadBytes,
  };
}

async function signedIn(test: Harness): Promise<void> {
  await test.backend.signIn({ email: "viewer@example.com" });
  await test.backend.verifyEmail();
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("sign-in and the free balance", () => {
  it("grants $2.50 once the email is verified, and only once", async () => {
    const test = harness();
    const session = await test.backend.signIn({ email: "viewer@example.com" });
    expect(session.emailVerified).toBe(false);

    await test.backend.verifyEmail();
    const me = await test.backend.getMe();
    expect(me.balanceCents).toBe(250);
    expect(me.freeCents).toBe(250);
    expect(me.transactions.at(-1)).toMatchObject({ reason: "grant", deltaCents: 250 });

    // Deleting the account and signing up again must not pay a second time.
    await test.backend.deleteAccount();
    await test.backend.signIn({ email: "viewer@example.com" });
    await test.backend.verifyEmail();
    expect((await test.backend.getMe()).balanceCents).toBe(0);
  });

  it("refuses to translate before the email is verified", async () => {
    const test = harness();
    await test.backend.signIn({ email: "viewer@example.com" });
    await expect(test.upload(["the-lamp-room.srt"])).rejects.toMatchObject({
      body: { code: "email-not-verified" },
    });
  });
});

describe("the preview and the charge", () => {
  it("prices every file, charges the wallet and spends free money first", async () => {
    const test = harness();
    await signedIn(test);

    const uploadIds = await test.upload(["the-lamp-room.srt", "the-last-tender.srt"]);
    const created = await test.backend.createBatch({
      uploadIds,
      targetLanguage: "de",
      lane: "fast",
      options: DEFAULT_TRANSLATION_OPTIONS,
    });

    const expected = created.batch.jobs.reduce(
      (sum, job) =>
        sum + priceCents({ dialogueChars: job.dialogueChars, cueCount: job.cueCount }, "fast"),
      0,
    );
    expect(created.batch.priceCents).toBe(expected);
    expect(created.balanceCents).toBe(250 - expected);
    expect(created.freeCents).toBe(250 - expected);

    const me = await test.backend.getMe();
    const charge = me.transactions.find((entry) => entry.reason === "charge");
    expect(charge).toMatchObject({ deltaCents: -expected, freeDeltaCents: -expected });
    expect(me.transactions.reduce((sum, entry) => sum + entry.deltaCents, 0)).toBe(me.balanceCents);
  });

  it("answers 402 with the shortfall and the top-up that covers it", async () => {
    const test = harness();
    await signedIn(test);
    const uploadIds = await test.uploadBytes([
      { fileName: "a-very-long-film.srt", bytes: bigSubtitleFile(1_500) },
    ]);
    const failure = await test.backend
      .createBatch({
        uploadIds,
        targetLanguage: "de",
        lane: "fast",
        options: DEFAULT_TRANSLATION_OPTIONS,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    const error = failure as ApiError;
    expect(error.status).toBe(402);
    if (!error.is("insufficient-balance")) throw new Error("expected a 402");
    expect(error.body.balanceCents).toBe(250);
    expect(error.body.shortfallCents).toBe(error.body.totalCents - 250);
    expect(error.body.suggestedTopUpCents).toBe(500);
    // Nothing was charged by a refused batch.
    expect((await test.backend.getMe()).balanceCents).toBe(250);
  });

  it("refuses a target language the files are already in", async () => {
    const test = harness();
    await signedIn(test);
    const uploadIds = await test.upload(["der-leuchtturm.srt"]);
    await expect(
      test.backend.createBatch({
        uploadIds,
        targetLanguage: "de",
        lane: "fast",
        options: DEFAULT_TRANSLATION_OPTIONS,
      }),
    ).rejects.toMatchObject({ body: { code: "target-is-source-language" } });
  });
});

describe("translating", () => {
  it("moves a file through queued, running and done, and delivers it intact", async () => {
    const test = harness();
    await signedIn(test);
    const uploadIds = await test.upload(["the-lamp-room.srt"]);
    const created = await test.backend.createBatch({
      uploadIds,
      targetLanguage: "de",
      lane: "fast",
      options: DEFAULT_TRANSLATION_OPTIONS,
    });

    expect(created.batch.jobs[0]?.status).toBe("running");
    expect(created.batch.jobs[0]?.downloadUrl).toBeNull();

    test.advance(2_000);
    const { batch } = await test.backend.getBatch(created.batch.batchId);
    const job = batch.jobs[0];
    expect(batch.status).toBe("done");
    expect(job?.status).toBe("done");
    expect(job?.outputFileName).toBe("the-lamp-room.de.srt");
    expect(job?.report?.translatedCues).toBe(job?.cueCount);
    expect(job?.downloadUrl).not.toBeNull();

    // The fidelity promise: same cues, same timing lines, only the text changed.
    const source = parseSubtitleText(new TextDecoder().decode(sample("the-lamp-room.srt")));
    const translated = parseSubtitleText(await readUrl(job?.downloadUrl ?? ""));
    expect(translated.cues).toHaveLength(source.cues.length);
    expect(translated.cues.map((cue) => cue.rawTimingLine)).toEqual(
      source.cues.map((cue) => cue.rawTimingLine),
    );
    expect(translated.cues[1]?.lines.join(" ")).toContain("«");
  });

  it("refunds a file that fails and leaves the rest of the upload alone", async () => {
    const test = harness();
    await signedIn(test);
    const uploadIds = await test.upload(["the-lamp-room.srt", "fail.srt"]);
    const created = await test.backend.createBatch({
      uploadIds,
      targetLanguage: "de",
      lane: "fast",
      options: DEFAULT_TRANSLATION_OPTIONS,
    });
    const charged = created.batch.priceCents;

    test.advance(2_000);
    const { batch } = await test.backend.getBatch(created.batch.batchId);
    expect(batch.status).toBe("partial");

    const failed = batch.jobs.find((job) => job.fileName === "fail.srt");
    const kept = batch.jobs.find((job) => job.fileName === "the-lamp-room.srt");
    expect(failed?.status).toBe("failed");
    expect(failed?.refundedCents).toBe(failed?.priceCents);
    expect(failed?.error).toContain("refunded");
    expect(kept?.status).toBe("done");

    const me = await test.backend.getMe();
    expect(me.balanceCents).toBe(250 - charged + (failed?.priceCents ?? 0));
    expect(me.transactions.some((entry) => entry.reason === "refund")).toBe(true);
    expect(me.transactions.reduce((sum, entry) => sum + entry.deltaCents, 0)).toBe(me.balanceCents);
  });

  it("holds an economy-lane upload as submitted, then returns it with one glossary", async () => {
    const test = harness();
    await signedIn(test);
    const uploadIds = await test.upload([
      "season/skerry-point-s01e01.srt",
      "season/skerry-point-s01e02.srt",
    ]);
    const created = await test.backend.createBatch({
      uploadIds,
      targetLanguage: "bg",
      lane: "economy",
      options: DEFAULT_TRANSLATION_OPTIONS,
    });

    expect(created.batch.status).toBe("submitted");
    expect(created.batch.notice).toContain("within the hour");
    expect(created.batch.seasonGlossary?.applied).toBe(true);

    test.advance(3_000);
    const { batch } = await test.backend.getBatch(created.batch.batchId);
    expect(batch.status).toBe("done");
    expect(batch.zipUrl).not.toBeNull();

    const zip = unzipSync(await readUrlBytes(batch.zipUrl ?? ""));
    expect(Object.keys(zip).sort()).toEqual([
      "skerry-point-s01e01.bg.srt",
      "skerry-point-s01e02.bg.srt",
    ]);
  });
});

describe("the wallet", () => {
  it("credits a confirmed top-up a moment after the checkout, as the webhook would", async () => {
    const test = harness();
    await signedIn(test);
    const checkout = await test.backend.createTopUp({ amountCents: 1000 });
    expect(checkout.checkoutUrl).toContain(checkout.sessionId);

    await test.backend.completeCheckout(checkout.sessionId);
    expect((await test.backend.getMe()).balanceCents).toBe(250);

    test.advance(200);
    const me = await test.backend.getMe();
    expect(me.balanceCents).toBe(1250);
    expect(me.freeCents).toBe(250);
    expect(me.transactions[0]).toMatchObject({ reason: "topup", deltaCents: 1000 });
  });

  it("keeps the balance and the history across a reload", async () => {
    const first = harness();
    await signedIn(first);
    await first.backend.createTopUp({ amountCents: 500 }).then(async (checkout) => {
      await first.backend.completeCheckout(checkout.sessionId);
    });
    first.advance(200);
    await first.backend.getMe();

    const second = harness();
    const me = await second.backend.getMe();
    expect(me.balanceCents).toBe(750);
    expect(me.user.email).toBe("viewer@example.com");
  });
});

describe("the seeded demo", () => {
  it("starts signed in, with the free balance and one finished upload", async () => {
    const test = harness({ seedDemo: true });
    const session = await test.backend.getSession();
    expect(session).toMatchObject({ email: DEMO_EMAIL, emailVerified: true });

    const me = await test.backend.getMe();
    expect(me.freeCents).toBeGreaterThan(0);
    expect(me.recentBatches).toHaveLength(1);
    expect(me.recentBatches[0]?.status).toBe("done");
    expect(me.transactions.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(["grant", "topup", "charge"]),
    );

    const history = await test.backend.listBatches();
    const batch = await test.backend.getBatch(history.batches[0]?.batchId ?? "");
    expect(batch.batch.jobs.every((job) => job.downloadUrl !== null)).toBe(true);
  });

  it("puts the demo back the way it started", async () => {
    const test = harness({ seedDemo: true });
    await test.backend.getMe();
    const uploadIds = await test.upload(["the-lamp-room.srt"]);
    await test.backend.createBatch({
      uploadIds,
      targetLanguage: "fr",
      lane: "fast",
      options: DEFAULT_TRANSLATION_OPTIONS,
    });
    expect((await test.backend.listBatches()).batches).toHaveLength(2);

    await test.backend.demo.reset();
    expect((await test.backend.listBatches()).batches).toHaveLength(1);
  });
});

async function readUrl(url: string): Promise<string> {
  return new TextDecoder().decode(await readUrlBytes(url));
}

/** Reads back what a download link would hand the browser. */
function readUrlBytes(url: string): Promise<Uint8Array> {
  const marker = ";base64,";
  const at = url.indexOf(marker);
  if (!url.startsWith("data:") || at === -1) {
    throw new Error(`expected a download URL, received ${url.slice(0, 24)}`);
  }
  const binary = atob(url.slice(at + marker.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return Promise.resolve(bytes);
}
