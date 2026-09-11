import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTranslationModelClient } from "@lexicue/harness";
import { FREE_BALANCE_CENTS, priceCents } from "@lexicue/pricing";
import { ledgerBalance, type ApiErrorBody, type Batch, type MeResponse } from "@lexicue/shared";
import { parseSubtitleText } from "@lexicue/subtitles";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { createDevApi, type DevApi } from "./server.js";

/**
 * The local development API against the deterministic fake model client: no
 * key, no network, no clock to wait on. What is asserted here is everything the
 * server is authoritative for — the routes of spec section 7.3, the state
 * machine of an upload, the limits of section 3.2, the refusals, the wallet
 * arithmetic of section 7.4, the downloads and the zip.
 */

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "The lighthouse has been dark for a week.",
  "",
  "2",
  "00:00:03,400 --> 00:00:06,120 X1:100 X2:620 Y1:420 Y2:480",
  "- And nobody thought to call?",
  "- <i>We called.</i>",
  "",
  "3",
  "00:00:06,300 --> 00:00:08,000",
  "Then we row out at first light.",
  "",
].join("\n");

const SPANISH = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "No es que no quiera, es que no puedo.",
  "",
  "2",
  "00:00:03,400 --> 00:00:06,000",
  "Por favor, dime que no los llamaste.",
  "",
  "3",
  "00:00:06,300 --> 00:00:09,000",
  "Los llamé. Que vengan por la mañana.",
  "",
].join("\n");

interface Harness {
  api: DevApi;
  base: string;
  /** A request with the development session token attached. */
  call: (path: string, init?: RequestInit) => Promise<Response>;
  /** Verifying reissues the token, exactly as Cognito would. */
  verify: () => Promise<void>;
}

const open: { server: Server; dir: string }[] = [];

afterEach(() => {
  for (const { server, dir } of open.splice(0)) {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function start(options: { verified?: boolean; background?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "lexicue-dev-api-"));
  const api = createDevApi({
    client: new FakeTranslationModelClient(),
    stateDir: dir,
    runInBackground: options.background ?? false,
  });
  // An explicit IPv4 loopback so the port the test connects to is the port the
  // server bound; `pnpm dev` uses the default, "localhost".
  const server = await api.listen(0, "127.0.0.1");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  open.push({ server, dir });
  const base = `http://127.0.0.1:${address.port.toString()}`;

  const signIn = await fetch(`${base}/api/dev/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "founder@example.com" }),
  });
  let token = ((await signIn.json()) as { token: string }).token;

  const call = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(`${base}${path}`, { ...init, headers });
  };

  const verify = async (): Promise<void> => {
    const response = await call("/api/dev/verify", { method: "POST" });
    token = ((await response.json()) as { token: string }).token;
  };

  if (options.verified !== false) await verify();
  return { api, base, call, verify };
}

/** What the browser does: ask for targets, then POST the bytes to each one. */
async function upload(
  harness: Harness,
  files: { fileName: string; text: string }[],
): Promise<string[]> {
  const response = await harness.call("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      files: files.map((file) => ({
        fileName: file.fileName,
        byteLength: Buffer.byteLength(file.text),
      })),
    }),
  });
  const body = (await response.json()) as { uploads: { uploadId: string; url: string }[] };
  expect(response.status).toBe(200);

  for (const [index, target] of body.uploads.entries()) {
    const form = new FormData();
    form.append("key", `uploads/${target.uploadId}`);
    form.append("file", new Blob([files[index]?.text ?? ""], { type: "text/plain" }));
    const put = await fetch(`${harness.base}${target.url}`, { method: "POST", body: form });
    expect(put.status).toBe(204);
  }
  return body.uploads.map((target) => target.uploadId);
}

async function createBatch(
  harness: Harness,
  uploadIds: string[],
  overrides: { targetLanguage?: string; lane?: string } = {},
): Promise<Response> {
  return harness.call("/api/batches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uploadIds,
      targetLanguage: overrides.targetLanguage ?? "de",
      lane: overrides.lane ?? "fast",
      options: {
        formality: "auto",
        contextNote: "",
        lineHandling: "reflow",
        translateLyrics: true,
        outputBom: true,
      },
    }),
  });
}

async function errorOf(response: Response): Promise<ApiErrorBody> {
  return ((await response.json()) as { error: ApiErrorBody }).error;
}

describe("the unauthenticated routes", () => {
  it("serves the price list and the language list without a token", async () => {
    const harness = await start();
    const pricing = await fetch(`${harness.base}/api/pricing`);
    expect(pricing.status).toBe(200);
    const prices = (await pricing.json()) as { rates: unknown[]; freeBalanceCents: number };
    expect(prices.rates).toHaveLength(2);
    expect(prices.freeBalanceCents).toBe(FREE_BALANCE_CENTS);

    const languages = await fetch(`${harness.base}/api/languages`);
    const list = (await languages.json()) as { languages: { code: string }[] };
    expect(list.languages.some((language) => language.code === "de")).toBe(true);
  });

  it("refuses everything else without a token", async () => {
    const harness = await start();
    const response = await fetch(`${harness.base}/api/me`);
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthorised");
  });
});

describe("the session and the free balance", () => {
  it("grants the free balance once, when the email is verified", async () => {
    const harness = await start({ verified: false });
    const before = (await (await harness.call("/api/me")).json()) as MeResponse;
    expect(before.balanceCents).toBe(0);
    expect(before.user.emailVerified).toBe(false);

    await harness.verify();
    const after = (await (await harness.call("/api/me")).json()) as MeResponse;
    expect(after.balanceCents).toBe(FREE_BALANCE_CENTS);
    expect(after.freeCents).toBe(FREE_BALANCE_CENTS);
    expect(after.transactions).toHaveLength(1);
    expect(after.transactions[0]?.reason).toBe("grant");

    // A second verification must not pay twice.
    await harness.verify();
    const again = (await (await harness.call("/api/me")).json()) as MeResponse;
    expect(again.balanceCents).toBe(FREE_BALANCE_CENTS);
  });

  it("will not take an upload before the email is verified", async () => {
    const harness = await start({ verified: false });
    const response = await harness.call("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ fileName: "a.srt", byteLength: 10 }] }),
    });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("email-not-verified");
  });
});

describe("the lifecycle of an upload", () => {
  it("prices, charges, translates and hands back a file that re-parses", async () => {
    const harness = await start();
    const ids = await upload(harness, [{ fileName: "keeper.srt", text: SRT }]);
    const response = await createBatch(harness, ids);
    expect(response.status).toBe(202);

    const created = (await response.json()) as { batch: Batch; balanceCents: number };
    const expected = priceCents(parseSubtitleText(SRT).dialogueChars, "fast");
    expect(created.batch.priceCents).toBe(expected);
    expect(created.balanceCents).toBe(FREE_BALANCE_CENTS - expected);

    const batch = (
      (await (await harness.call(`/api/batches/${created.batch.batchId}`)).json()) as {
        batch: Batch;
      }
    ).batch;
    expect(batch.status).toBe("done");

    const job = batch.jobs[0];
    expect(job?.status).toBe("done");
    expect(job?.outputFileName).toBe("keeper.de.srt");
    expect(job?.batchesDone).toBe(job?.batchesTotal);
    expect(job?.report?.totalCues).toBe(3);
    expect(job?.downloadUrl).toBeTruthy();

    const download = await fetch(`${harness.base}${job?.downloadUrl ?? ""}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("keeper.de.srt");

    const bytes = new Uint8Array(await download.arrayBuffer());
    // UTF-8 with a byte-order mark is the default of spec section 3.1.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const source = parseSubtitleText(SRT);
    const output = parseSubtitleText(new TextDecoder().decode(bytes));
    expect(output.cues).toHaveLength(source.cues.length);
    expect(output.cues.map((cue) => cue.rawTimingLine)).toEqual(
      source.cues.map((cue) => cue.rawTimingLine),
    );
    expect(output.cues.map((cue) => cue.rawIndexLine)).toEqual(
      source.cues.map((cue) => cue.rawIndexLine),
    );
    // The fake model wraps dialogue in guillemets and touches nothing else.
    expect(output.cues[1]?.lines.join(" ")).toContain("<i>");
    expect(output.cues[0]?.lines.join(" ")).toContain("«");
  });

  it("reports real progress and settles the batch", async () => {
    const harness = await start({ background: true });
    const ids = await upload(harness, [{ fileName: "keeper.srt", text: SRT }]);
    const response = await createBatch(harness, ids);
    const created = (await response.json()) as { batch: Batch };
    // 202 comes back before the work is done, which is what the poll is for,
    // and the file is already running: its glossary pass starts immediately.
    expect(created.batch.status).toBe("running");
    expect(created.batch.jobs[0]?.status).toBe("running");
    expect(created.batch.pollAfterMs).toBe(2_000);

    await harness.api.idle();
    const batch = (
      (await (await harness.call(`/api/batches/${created.batch.batchId}`)).json()) as {
        batch: Batch;
      }
    ).batch;
    expect(batch.status).toBe("done");
    expect(batch.jobs[0]?.batchesDone).toBe(batch.jobs[0]?.batchesTotal);
    expect(batch.finishedAt).not.toBeNull();
    expect(batch.filesExpireAt).not.toBeNull();
  });

  it("shares one glossary across a multi-file upload and zips the results", async () => {
    const harness = await start();
    const ids = await upload(harness, [
      { fileName: "e01.srt", text: SRT },
      { fileName: "e02.srt", text: SRT },
    ]);
    const created = (await (await createBatch(harness, ids)).json()) as { batch: Batch };
    const batch = (
      (await (await harness.call(`/api/batches/${created.batch.batchId}`)).json()) as {
        batch: Batch;
      }
    ).batch;

    expect(batch.fileCount).toBe(2);
    expect(batch.doneCount).toBe(2);
    expect(batch.seasonGlossary?.applied).toBe(true);

    expect(batch.zipUrl).toBeTruthy();
    const zip = await fetch(`${harness.base}${batch.zipUrl ?? ""}`);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(["e01.de.srt", "e02.de.srt"]);
    for (const bytes of Object.values(entries)) {
      expect(parseSubtitleText(new TextDecoder().decode(bytes)).cues).toHaveLength(3);
    }
  });

  it("says above the rows that a multi-file upload runs in order", async () => {
    const harness = await start({ background: true });
    const ids = await upload(harness, [
      { fileName: "e01.srt", text: SRT },
      { fileName: "e02.srt", text: SRT },
    ]);
    const created = (await (await createBatch(harness, ids)).json()) as { batch: Batch };
    expect(created.batch.notice).toContain("in order");
    await harness.api.idle();
    // Once it has finished, the notice is gone: nothing is translating.
    const batch = (
      (await (await harness.call(`/api/batches/${created.batch.batchId}`)).json()) as {
        batch: Batch;
      }
    ).batch;
    expect(batch.notice).toBeNull();
  });

  it("refunds a file that fails without touching the rest", async () => {
    const harness = await start();
    const ids = await upload(harness, [
      { fileName: "good.srt", text: SRT },
      { fileName: "fail.srt", text: SRT },
    ]);
    const created = (await (await createBatch(harness, ids)).json()) as { batch: Batch };
    const batch = (
      (await (await harness.call(`/api/batches/${created.batch.batchId}`)).json()) as {
        batch: Batch;
      }
    ).batch;

    expect(batch.status).toBe("partial");
    expect(batch.doneCount).toBe(1);
    expect(batch.failedCount).toBe(1);
    const failed = batch.jobs.find((job) => job.fileName === "fail.srt");
    expect(failed?.status).toBe("failed");
    expect(failed?.refundedCents).toBe(failed?.priceCents);
    expect(failed?.error).toContain("refunded");
    expect(batch.jobs.find((job) => job.fileName === "good.srt")?.status).toBe("done");

    const me = (await (await harness.call("/api/me")).json()) as MeResponse;
    const charged = batch.priceCents - batch.refundedCents;
    expect(me.balanceCents).toBe(FREE_BALANCE_CENTS - charged);
    // The free portion of the refund went back, so a trial user lost nothing.
    expect(me.freeCents).toBe(me.balanceCents);
    expect(ledgerBalance({ ...me, ledger: me.transactions })).toBe(me.balanceCents);
  });
});

describe("what the server refuses", () => {
  it("refuses the economy lane in local development, before charging", async () => {
    const harness = await start();
    const ids = await upload(harness, [{ fileName: "keeper.srt", text: SRT }]);
    const response = await createBatch(harness, ids, { lane: "economy" });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("economy lane is not available");

    const me = (await (await harness.call("/api/me")).json()) as MeResponse;
    expect(me.balanceCents).toBe(FREE_BALANCE_CENTS);
  });

  it("refuses a file it cannot read, naming it", async () => {
    const harness = await start();
    const ids = await upload(harness, [{ fileName: "notes.txt", text: "just a note" }]);
    const response = await createBatch(harness, ids);
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("unusable-files");
    if (error.code !== "unusable-files") throw new Error("wrong code");
    expect(error.files[0]?.fileName).toBe("notes.txt");
  });

  it("refuses a target that is already the source language", async () => {
    const harness = await start();
    const ids = await upload(harness, [{ fileName: "faro.srt", text: SPANISH }]);
    const response = await createBatch(harness, ids, { targetLanguage: "es" });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("target-is-source-language");
  });

  it("refuses more files than an upload may carry", async () => {
    const harness = await start();
    const response = await harness.call("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: Array.from({ length: 51 }, (_unused, index) => ({
          fileName: `e${index.toString()}.srt`,
          byteLength: 10,
        })),
      }),
    });
    expect(response.status).toBe(429);
    const error = await errorOf(response);
    if (error.code !== "limit-exceeded") throw new Error("wrong code");
    expect(error.limit).toBe("files-per-upload");
  });

  it("refuses an upload the balance will not cover, with the shortfall", async () => {
    const harness = await start();
    const big = Array.from({ length: 120 }, (_unused, index) =>
      [(index + 1).toString(), "00:00:01,000 --> 00:00:03,000", "x".repeat(900), ""].join("\n"),
    ).join("\n");
    const ids = await upload(harness, [{ fileName: "film.srt", text: big }]);
    const response = await createBatch(harness, ids);
    expect(response.status).toBe(402);

    const error = await errorOf(response);
    if (error.code !== "insufficient-balance") throw new Error("wrong code");
    expect(error.balanceCents).toBe(FREE_BALANCE_CENTS);
    expect(error.shortfallCents).toBe(error.totalCents - FREE_BALANCE_CENTS);
    expect(error.suggestedTopUpCents).toBeGreaterThanOrEqual(error.shortfallCents);
  });
});

describe("the wallet and the demo controls", () => {
  it("credits a top-up when the checkout is confirmed", async () => {
    const harness = await start();
    const created = (await (
      await harness.call("/api/billing/topup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 1000 }),
      })
    ).json()) as { sessionId: string; checkoutUrl: string };
    expect(created.checkoutUrl).toContain("#/checkout/");

    await harness.call(`/api/dev/checkout/${created.sessionId}`, { method: "POST" });
    // Confirming twice must not credit twice; the deployed webhook is idempotent.
    await harness.call(`/api/dev/checkout/${created.sessionId}`, { method: "POST" });

    const me = (await (await harness.call("/api/me")).json()) as MeResponse;
    expect(me.balanceCents).toBe(FREE_BALANCE_CENTS + 1000);
    expect(me.freeCents).toBe(FREE_BALANCE_CENTS);
    expect(ledgerBalance({ ...me, ledger: me.transactions })).toBe(me.balanceCents);
  });

  it("refuses a top-up that is not one of the offered amounts", async () => {
    const harness = await start();
    const response = await harness.call("/api/billing/topup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountCents: 700 }),
    });
    expect(response.status).toBe(400);
  });

  it("deletes a batch's files on request and keeps the history row", async () => {
    const harness = await start();
    const ids = await upload(harness, [{ fileName: "keeper.srt", text: SRT }]);
    const created = (await (await createBatch(harness, ids)).json()) as { batch: Batch };

    const removed = await harness.call(`/api/batches/${created.batch.batchId}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);

    const batch = (
      (await (await harness.call(`/api/batches/${created.batch.batchId}`)).json()) as {
        batch: Batch;
      }
    ).batch;
    expect(batch.jobs[0]?.downloadUrl).toBeNull();
    expect(batch.filesExpireAt).toBeNull();
    const history = (await (await harness.call("/api/batches")).json()) as { batches: unknown[] };
    expect(history.batches).toHaveLength(1);
  });

  it("puts everything back on reset", async () => {
    const harness = await start();
    const ids = await upload(harness, [{ fileName: "keeper.srt", text: SRT }]);
    await createBatch(harness, ids);
    await fetch(`${harness.base}/api/dev/reset`, { method: "POST" });

    // The token went with the state, so the session is gone too.
    const response = await harness.call("/api/me");
    expect(response.status).toBe(401);
    expect(harness.api.store.current().batches).toHaveLength(0);
    expect(harness.api.store.current().balanceCents).toBe(0);
  });
});

describe("download links", () => {
  it("refuses an unsigned or tampered link", async () => {
    const harness = await start();
    const ids = await upload(harness, [{ fileName: "keeper.srt", text: SRT }]);
    const created = (await (await createBatch(harness, ids)).json()) as { batch: Batch };
    const job = created.batch.jobs[0];

    expect((await fetch(`${harness.base}/api/dev/files/${job?.jobId ?? ""}`)).status).toBe(404);

    const tampered = (job?.downloadUrl ?? "").replace(/signature=[0-9a-f]+/, "signature=beef");
    expect((await fetch(`${harness.base}${tampered}`)).status).toBe(404);
  });
});
