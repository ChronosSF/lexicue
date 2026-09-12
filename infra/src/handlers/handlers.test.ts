import {
  InMemoryFileStore,
  InMemoryMetadataStore,
  NO_DOWNLOADS,
  emptyAccount,
  uploadKey,
  type AccountData,
} from "@lexicue/core";
import { FakeTranslationModelClient } from "@lexicue/harness";
import { FREE_BALANCE_CENTS } from "@lexicue/pricing";
import { describe, expect, it } from "vitest";
import { callerOf, routeRequest, type ProxyEvent } from "./api.js";
import { consume, type QueueEvent } from "./worker.js";

/**
 * The two Lambda handlers, driven with hand-written events and in-memory
 * stores.
 *
 * This is what "the shape is real" means. The stacks in `../stacks.test.ts`
 * prove the templates; these prove that an API Gateway event and an SQS message
 * actually reach `@lexicue/core` and come back as the contract of section 7.3 —
 * the same rules, the same prices, the same refunds as `packages/dev-api`,
 * because it is the same code underneath.
 *
 * What is *not* proved here is DynamoDB or S3. Those adapters are deliberately
 * unimplemented (`../adapters/aws-stores.ts`), so the `handler` exports fail
 * closed and the tests drive `routeRequest` and `consume` instead.
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
].join("\n");

const NOW = Date.parse("2026-09-12T09:00:00.000Z");

function account(): AccountData {
  const data = emptyAccount();
  data.account.user = {
    userId: "sub-1",
    email: "founder@example.com",
    emailVerified: true,
    createdAt: NOW,
  };
  data.account.balanceCents = FREE_BALANCE_CENTS;
  data.account.freeCents = FREE_BALANCE_CENTS;
  return data;
}

function event(
  method: string,
  path: string,
  options: { body?: unknown; signedIn?: boolean } = {},
): ProxyEvent {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      ...(options.signedIn === false
        ? {}
        : {
            authorizer: {
              jwt: {
                claims: { sub: "sub-1", email: "founder@example.com", email_verified: true },
              },
            },
          }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  };
}

describe("the API handler", () => {
  function dependencies(data: AccountData = account()) {
    const metadata = new InMemoryMetadataStore(data);
    const files = new InMemoryFileStore();
    return { metadata, files, downloads: NO_DOWNLOADS, now: () => NOW };
  }

  it("answers the two unauthenticated routes of section 7.3", async () => {
    const dependency = dependencies();
    const pricing = await routeRequest(
      event("GET", "/api/pricing", { signedIn: false }),
      dependency,
    );
    expect(pricing.statusCode).toBe(200);
    expect(JSON.parse(pricing.body)).toMatchObject({ minimumPriceCents: 10 });

    const languages = await routeRequest(
      event("GET", "/api/languages", { signedIn: false }),
      dependency,
    );
    const list = JSON.parse(languages.body) as { languages: { code: string }[] };
    // Section 3.3's curated list, not "anything the model can do".
    expect(list.languages.length).toBeGreaterThan(30);
    expect(list.languages.map((language) => language.code)).toContain("de");
  });

  /**
   * Unreachable behind the authorizer, and therefore exactly the case worth a
   * test: a route that lost its authorizer must fail closed, not open.
   */
  it("refuses an authenticated route with no claims on the event", async () => {
    const response = await routeRequest(
      event("GET", "/api/me", { signedIn: false }),
      dependencies(),
    );
    expect(response.statusCode).toBe(401);
  });

  it("reads the caller out of the authorizer's claims", () => {
    expect(callerOf(event("GET", "/api/me"))).toEqual({
      userId: "sub-1",
      email: "founder@example.com",
      emailVerified: true,
    });
  });

  it("returns the balance and the limits on /api/me", async () => {
    const response = await routeRequest(event("GET", "/api/me"), dependencies());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      balanceCents: FREE_BALANCE_CENTS,
      limits: { maxFilesPerUpload: 50, maxFilesPerDay: 100 },
    });
  });

  /**
   * The one route that takes money, through a Lambda event. It charges and
   * leaves the row `queued`, because on this side a queue-backed worker has not
   * picked the message up yet (section 7.5) — the opposite of the local API,
   * which starts in its own process and says `running`.
   */
  it("charges for a batch and leaves the job queued for the worker", async () => {
    const dependency = dependencies();
    const created = await routeRequest(
      event("POST", "/api/uploads", {
        body: { files: [{ fileName: "film.srt", byteLength: 90 }] },
      }),
      dependency,
    );
    const uploadId = (JSON.parse(created.body) as { uploads: { uploadId: string }[] }).uploads[0]
      ?.uploadId;
    expect(uploadId).toBeDefined();
    await dependency.files.put(uploadKey(uploadId ?? ""), new TextEncoder().encode(SRT));

    const response = await routeRequest(
      event("POST", "/api/batches", {
        body: {
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
      }),
      dependency,
    );

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as {
      batch: { status: string; priceCents: number; jobs: { status: string }[] };
      balanceCents: number;
    };
    expect(body.batch.status).toBe("queued");
    expect(body.batch.jobs[0]?.status).toBe("queued");
    expect(body.batch.priceCents).toBe(10);
    expect(body.balanceCents).toBe(FREE_BALANCE_CENTS - 10);
  });

  it("turns a contract violation into a 400 and an unknown route into a 404", async () => {
    const dependency = dependencies();
    const bad = await routeRequest(
      event("POST", "/api/batches", { body: { uploadIds: "not an array" } }),
      dependency,
    );
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ error: { code: "bad-request" } });

    const missing = await routeRequest(event("GET", "/api/nothing"), dependency);
    expect(missing.statusCode).toBe(404);
  });
});

describe("the worker handler", () => {
  it("translates an upload off the queue and settles the batch", async () => {
    const data = account();
    const metadata = new InMemoryMetadataStore(data);
    const files = new InMemoryFileStore();
    const dependency = { metadata, files, downloads: NO_DOWNLOADS, now: () => NOW };

    const created = await routeRequest(
      event("POST", "/api/uploads", {
        body: { files: [{ fileName: "film.srt", byteLength: 90 }] },
      }),
      dependency,
    );
    const uploadId =
      (JSON.parse(created.body) as { uploads: { uploadId: string }[] }).uploads[0]?.uploadId ?? "";
    await files.put(uploadKey(uploadId), new TextEncoder().encode(SRT));
    const batch = await routeRequest(
      event("POST", "/api/batches", {
        body: {
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
      }),
      dependency,
    );
    const created202 = JSON.parse(batch.body) as {
      batch: { batchId: string; jobs: { jobId: string }[] };
    };

    const message: QueueEvent = {
      Records: [
        {
          messageId: "msg-1",
          body: JSON.stringify({
            userId: "sub-1",
            batchId: created202.batch.batchId,
            jobId: created202.batch.jobs[0]?.jobId,
          }),
        },
      ],
    };

    const result = await consume(message, {
      storesFor: () => ({ metadata, files }),
      client: new FakeTranslationModelClient(),
      now: () => NOW,
    });

    expect(result.batchItemFailures).toEqual([]);
    const settled = metadata.snapshot();
    expect(settled.batches[0]?.status).toBe("done");
    expect(settled.jobs[0]?.status).toBe("done");
    expect(settled.jobs[0]?.report?.totalCues).toBe(2);
    expect(await files.get(`outputs/${settled.jobs[0]?.jobId ?? ""}`)).not.toBeNull();
  });

  /**
   * Section 7.5: SQS redelivers once and the second failure goes to the
   * dead-letter queue. Reporting the failed ids is what makes "once" mean the
   * message rather than the whole receive.
   */
  it("reports the message that failed rather than throwing", async () => {
    const result = await consume(
      { Records: [{ messageId: "msg-bad", body: "not json" }] },
      {
        storesFor: () => ({
          metadata: new InMemoryMetadataStore(account()),
          files: new InMemoryFileStore(),
        }),
        client: new FakeTranslationModelClient(),
      },
    );
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-bad" }]);
  });

  it("treats a message for a job that is already settled as done", async () => {
    const result = await consume(
      {
        Records: [
          {
            messageId: "msg-2",
            body: JSON.stringify({ userId: "sub-1", batchId: "bat_gone", jobId: "job_gone" }),
          },
        ],
      },
      {
        storesFor: () => ({
          metadata: new InMemoryMetadataStore(account()),
          files: new InMemoryFileStore(),
        }),
        client: new FakeTranslationModelClient(),
      },
    );
    expect(result.batchItemFailures).toEqual([]);
  });
});
