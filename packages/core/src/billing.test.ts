import { FREE_BALANCE_CENTS } from "@lexicue/pricing";
import { ApiError, ledgerBalance } from "@lexicue/shared";
import { describe, expect, it } from "vitest";
import {
  FakeStripeClient,
  SIGNATURE_TOLERANCE_SECONDS,
  StripeSignatureError,
  parseStripeEvent,
  signStripePayload,
  verifyStripeSignature,
} from "./billing.js";
import { InMemoryFileStore, InMemoryMetadataStore } from "./memory.js";
import { emptyAccount, walletView, type AccountData } from "./records.js";
import { ApiService } from "./service.js";
import { NO_DOWNLOADS } from "./stores.js";

/**
 * Stripe, as far as a repository with no Stripe account can be tested.
 *
 * The signature is the part that matters most and the part that needs no key,
 * because a test can sign a body itself — so it is tested against a tampered
 * body, a wrong secret, a replayed timestamp, a missing header and a header
 * mid-rotation. The webhook path is then tested end to end against
 * `FakeStripeClient`, including the thing section 6.6 is really asking for: a
 * redelivered event must credit nothing.
 *
 * What is not tested is `HttpStripeClient`, because nothing has ever called
 * Stripe. The root README says so and says what the founder must set.
 */

const SECRET = "whsec_test_bd4ea3a9c1e04f0f8f9a";
const NOW = Date.parse("2026-09-12T09:00:00.000Z");

describe("the webhook signature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a signature it just made", async () => {
    const header = await signStripePayload(body, SECRET, NOW / 1000);
    await expect(verifyStripeSignature(body, header, SECRET, NOW)).resolves.toBeUndefined();
  });

  /**
   * The whole point of verifying: a body that changed after signing must fail,
   * even by one character, which is what a handler that parses JSON first and
   * re-serialises it would do to itself.
   */
  it("rejects a body that changed after it was signed", async () => {
    const header = await signStripePayload(body, SECRET, NOW / 1000);
    const tampered = body.replace("evt_1", "evt_2");
    await expect(verifyStripeSignature(tampered, header, SECRET, NOW)).rejects.toBeInstanceOf(
      StripeSignatureError,
    );
  });

  it("rejects a signature made with a different secret", async () => {
    const header = await signStripePayload(body, "whsec_somebody_else", NOW / 1000);
    await expect(verifyStripeSignature(body, header, SECRET, NOW)).rejects.toThrow(
      /no v1 signature matched/,
    );
  });

  /** A replay: the signature is valid for ever, the timestamp is not. */
  it("rejects a signature older than the tolerance", async () => {
    const old = NOW / 1000 - SIGNATURE_TOLERANCE_SECONDS - 1;
    const header = await signStripePayload(body, SECRET, old);
    await expect(verifyStripeSignature(body, header, SECRET, NOW)).rejects.toThrow(
      /seconds away from now/,
    );
  });

  it("accepts a header carrying several signatures, as a rotation does", async () => {
    const good = await signStripePayload(body, SECRET, NOW / 1000);
    const other = await signStripePayload(body, "whsec_old_secret", NOW / 1000);
    const merged = `${other},${good.slice(good.indexOf("v1="))}`;
    await expect(verifyStripeSignature(body, merged, SECRET, NOW)).resolves.toBeUndefined();
  });

  it("rejects a missing header, an empty secret and a header with no v1", async () => {
    await expect(verifyStripeSignature(body, undefined, SECRET, NOW)).rejects.toThrow(
      /header is missing/,
    );
    const header = await signStripePayload(body, SECRET, NOW / 1000);
    await expect(verifyStripeSignature(body, header, "", NOW)).rejects.toThrow(
      /no endpoint secret/,
    );
    await expect(
      verifyStripeSignature(body, `t=${(NOW / 1000).toString()}`, SECRET, NOW),
    ).rejects.toThrow(/no v1 signature/);
    await expect(verifyStripeSignature(body, "v1=abc", SECRET, NOW)).rejects.toThrow(
      /no timestamp/,
    );
  });
});

describe("parsing an event", () => {
  it("ignores an event type nobody subscribed to", () => {
    const raw = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    expect(parseStripeEvent(raw)).toBeNull();
  });

  it("refuses an event with no user on it rather than guessing", () => {
    const raw = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      created: 1,
      data: { object: { id: "cs_1", amount_total: 500 } },
    });
    expect(() => parseStripeEvent(raw)).toThrow(ApiError);
  });

  it("refuses a body that is not JSON and one that is not an event", () => {
    expect(() => parseStripeEvent("not json")).toThrow(/not valid JSON/);
    expect(() => parseStripeEvent(JSON.stringify({ hello: true }))).toThrow(/not a Stripe event/);
  });
});

describe("the top-up and the webhook, end to end", () => {
  /**
   * The account is seeded through `verifyEmail` rather than by assigning a
   * balance, so the grant is on the ledger and every one of these tests can
   * assert the invariant section 8's nightly job checks: the balance equals the
   * sum of the ledger. Setting the number directly would have made that
   * assertion fail for a reason that has nothing to do with Stripe — which is
   * exactly what it did the first time this file was run.
   */
  async function fixture(): Promise<{
    service: ApiService;
    metadata: InMemoryMetadataStore;
    stripe: FakeStripeClient;
  }> {
    const seeded: AccountData = emptyAccount();
    seeded.account.user = {
      userId: "usr_1",
      email: "founder@example.com",
      emailVerified: false,
      createdAt: NOW,
    };
    const metadata = new InMemoryMetadataStore(seeded);
    const stripe = new FakeStripeClient();
    let counter = 0;
    const service = new ApiService({
      metadata,
      files: new InMemoryFileStore(),
      downloads: NO_DOWNLOADS,
      environment: {
        now: () => NOW,
        newId: (prefix) => {
          counter += 1;
          return `${prefix}_${counter.toString()}`;
        },
      },
      stripe,
    });
    // Verifying is what grants the $2.50, and what puts it on the ledger.
    await service.verifyEmail(NOW);
    return { service, metadata, stripe };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function topUp(f: Fixture, amountCents: number): Promise<string> {
    const session = await f.service.topUp({ amountCents }, NOW, () => "unused", {
      successUrl: "https://lexicue.io/#/wallet",
      cancelUrl: "https://lexicue.io/#/wallet",
    });
    // The hosted page, which is where card details go and this code does not.
    expect(session.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    return session.sessionId;
  }

  it("creates a hosted Checkout Session and credits on the webhook", async () => {
    const f = await fixture();
    const sessionId = await topUp(f, 500);
    const { rawBody } = f.stripe.complete(sessionId, NOW);

    const event = parseStripeEvent(rawBody);
    expect(event).not.toBeNull();
    if (event === null) throw new Error("no event");
    const result = await f.service.applyStripeEvent(event, NOW);

    expect(result.applied).toBe(true);
    expect(result.balanceCents).toBe(FREE_BALANCE_CENTS + 500);
    const data = f.metadata.snapshot();
    expect(data.checkouts[0]).toMatchObject({ status: "paid", credited: true });
    expect(ledgerBalance(walletView(data))).toBe(data.account.balanceCents);
  });

  /**
   * Section 6.6's whole reason for the marker: Stripe retries for three days,
   * and the runbook in 11.2 replays events from the dashboard by hand.
   */
  it("credits once however many times the same event arrives", async () => {
    const f = await fixture();
    const sessionId = await topUp(f, 1000);
    const { rawBody } = f.stripe.complete(sessionId, NOW);
    const event = parseStripeEvent(rawBody);
    if (event === null) throw new Error("no event");

    const first = await f.service.applyStripeEvent(event, NOW);
    const second = await f.service.applyStripeEvent(event, NOW + 1000);
    const third = await f.service.applyStripeEvent(event, NOW + 2000);

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(third.applied).toBe(false);
    const data = f.metadata.snapshot();
    expect(data.account.balanceCents).toBe(FREE_BALANCE_CENTS + 1000);
    expect(data.ledger.filter((entry) => entry.reason === "topup")).toHaveLength(1);
    expect(data.stripeEvents).toHaveLength(1);
    expect(ledgerBalance(walletView(data))).toBe(data.account.balanceCents);
  });

  /**
   * Section 6.6: a refund removes the corresponding unspent balance and the
   * balance never goes below zero. The free grant is never clawed back, because
   * nobody paid for it.
   */
  it("takes back a refunded payment without touching the free grant", async () => {
    const f = await fixture();
    const sessionId = await topUp(f, 500);
    const completed = parseStripeEvent(f.stripe.complete(sessionId, NOW).rawBody);
    if (completed === null) throw new Error("no event");
    await f.service.applyStripeEvent(completed, NOW);

    const refunded = parseStripeEvent(f.stripe.refund(sessionId, 500, NOW).rawBody);
    if (refunded === null) throw new Error("no event");
    const result = await f.service.applyStripeEvent(refunded, NOW);

    expect(result.balanceCents).toBe(FREE_BALANCE_CENTS);
    const data = f.metadata.snapshot();
    expect(data.account.freeCents).toBe(FREE_BALANCE_CENTS);
    expect(data.ledger.at(-1)).toMatchObject({ reason: "reversal", deltaCents: -500 });
    expect(ledgerBalance(walletView(data))).toBe(data.account.balanceCents);
  });

  it("never lets a refund push the balance below zero", async () => {
    const f = await fixture();
    const sessionId = await topUp(f, 500);
    const completed = parseStripeEvent(f.stripe.complete(sessionId, NOW).rawBody);
    if (completed === null) throw new Error("no event");
    await f.service.applyStripeEvent(completed, NOW);

    // Stripe refunds far more than is left, which a dispute can do.
    const refunded = parseStripeEvent(f.stripe.refund(sessionId, 100_000, NOW).rawBody);
    if (refunded === null) throw new Error("no event");
    await f.service.applyStripeEvent(refunded, NOW);

    const data = f.metadata.snapshot();
    // The grant survives; the paid part is gone; nothing is negative.
    expect(data.account.balanceCents).toBe(FREE_BALANCE_CENTS);
    expect(data.account.balanceCents).toBeGreaterThanOrEqual(0);
    expect(ledgerBalance(walletView(data))).toBe(data.account.balanceCents);
  });

  /** Section 8's nightly job, and section 11.2's webhook-outage runbook. */
  it("reconciles the ledger and names a completed session that never credited", async () => {
    const f = await fixture();
    const sessionId = await topUp(f, 500);
    const { event } = f.stripe.complete(sessionId, NOW);

    const before = await f.service.reconcile(NOW, f.stripe);
    expect(before.balanced).toBe(true);
    expect(before.missingCredits).toEqual([event.id]);

    await f.service.applyStripeEvent(event, NOW);
    const after = await f.service.reconcile(NOW, f.stripe);
    expect(after.balanced).toBe(true);
    expect(after.missingCredits).toEqual([]);
    expect(after.balanceCents).toBe(FREE_BALANCE_CENTS + 500);
  });

  it("falls back to a local checkout URL when there is no Stripe", async () => {
    const seeded = emptyAccount();
    seeded.account.user = {
      userId: "usr_1",
      email: "founder@example.com",
      emailVerified: true,
      createdAt: NOW,
    };
    const service = new ApiService({
      metadata: new InMemoryMetadataStore(seeded),
      files: new InMemoryFileStore(),
      downloads: NO_DOWNLOADS,
      environment: { now: () => NOW, newId: () => "cs_local" },
    });
    const session = await service.topUp({ amountCents: 500 }, NOW, (id) => `#/checkout/${id}`);
    expect(session.checkoutUrl).toBe("#/checkout/cs_local");
  });
});
