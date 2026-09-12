import { ApiError } from "@lexicue/shared";

/**
 * Stripe, from specification section 6.6, with the one security-critical part
 * written out rather than imported.
 *
 * **Nothing here has ever talked to Stripe.** There is no account and no key
 * (see the root README), so this is split deliberately into the part that can
 * be proved without one and the part that cannot:
 *
 * - {@link verifyStripeSignature} is Stripe's documented scheme —
 *   `HMAC-SHA256` over `{timestamp}.{body}` with the endpoint secret, compared
 *   against the `v1` values in the `Stripe-Signature` header, inside a
 *   timestamp tolerance. It needs no key to test, because a test can sign a
 *   body itself, so it is tested properly: a good signature, a tampered body,
 *   a wrong secret, a replayed timestamp, a missing header and a header with
 *   several signatures in it.
 * - {@link StripeClient} is the two calls that do need a key. The fake
 *   implementation is what the tests use; the HTTP one names the exact endpoint
 *   and parameters and has never been run.
 *
 * There is no `stripe` package in this repository. The SDK's value is in the
 * breadth of the API it wraps, and this product uses three calls of it; a
 * megabyte of unexercised dependency would not have made the untested part any
 * less untested, and the part that matters most — the signature — is better
 * written out where it can be read.
 */

/** A Checkout Session, as much of it as this product uses (section 6.6). */
export interface StripeCheckoutSession {
  id: string;
  /** The hosted page the browser is sent to. Card details never reach us. */
  url: string;
  amountCents: number;
  /** The user id, which is how a webhook knows whose balance to credit. */
  clientReferenceId: string;
  status: "open" | "complete" | "expired";
}

/** The events section 6.6 acts on, and nothing else. */
export type StripeEventType = "checkout.session.completed" | "charge.refunded";

export interface StripeEvent {
  id: string;
  type: StripeEventType;
  createdAt: number;
  /** `client_reference_id` on the session, or the charge's metadata. */
  userId: string;
  amountCents: number;
  /** The session this event refers to, when it has one. */
  sessionId: string | null;
}

export interface CreateCheckoutSessionInput {
  userId: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeClient {
  /** Payment mode, `client_reference_id` set, amount in metadata (6.6). */
  createCheckoutSession: (input: CreateCheckoutSessionInput) => Promise<StripeCheckoutSession>;
  /** For reconciliation: what Stripe thinks happened to a session. */
  retrieveSession: (sessionId: string) => Promise<StripeCheckoutSession | null>;
  /**
   * Events since a timestamp, newest first. Section 11.2's runbook replays from
   * the dashboard after a webhook outage; reconciliation uses this to find the
   * ones that never arrived at all.
   */
  listEvents: (sinceSeconds: number) => Promise<StripeEvent[]>;
}

// --------------------------------------------------------------- signatures

/** Stripe's own default: an event older than this is a replay (section 6.6). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(`Stripe signature rejected: ${message}`);
    this.name = "StripeSignatureError";
  }
}

/**
 * Verifies a `Stripe-Signature` header against the raw request body.
 *
 * The raw body matters and is the thing most easily got wrong: the signature
 * covers the bytes Stripe sent, so a handler that parses JSON first and
 * re-serialises it will fail every time, and one that verifies a re-serialised
 * body would accept a forgery. Every caller in this repository passes the
 * bytes, and the adapters read them before anything else touches the request.
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  now: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): Promise<void> {
  if (signatureHeader === undefined || signatureHeader === "") {
    throw new StripeSignatureError("the header is missing");
  }
  if (secret === "") {
    throw new StripeSignatureError("no endpoint secret is configured");
  }

  let timestamp: string | null = null;
  const candidates: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamp = value;
    // A header can carry several `v1` values while a secret is being rotated.
    if (key === "v1") candidates.push(value);
  }

  if (timestamp === null) throw new StripeSignatureError("the header carries no timestamp");
  if (candidates.length === 0) throw new StripeSignatureError("the header carries no v1 signature");

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) throw new StripeSignatureError("the timestamp is not a number");
  const ageSeconds = Math.abs(Math.floor(now / 1000) - sentAt);
  if (ageSeconds > toleranceSeconds) {
    throw new StripeSignatureError(
      `the timestamp is ${ageSeconds.toString()} seconds away from now, and the tolerance is ${toleranceSeconds.toString()}`,
    );
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  // Constant time across every candidate: comparing with `===` and returning
  // early would leak how many leading bytes of a guess were right.
  let matched = false;
  for (const candidate of candidates) {
    if (constantTimeEquals(expected, candidate)) matched = true;
  }
  if (!matched) throw new StripeSignatureError("no v1 signature matched the body");
}

/** The other half of the scheme, so a test can sign a body it made up. */
export async function signStripePayload(
  rawBody: string,
  secret: string,
  atSeconds: number,
): Promise<string> {
  const timestamp = Math.floor(atSeconds).toString();
  const signature = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return `t=${timestamp},v1=${signature}`;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEquals(left: string, right: string): boolean {
  // Length is not a secret — both are hex digests of a known size — but the
  // contents are, so every byte is compared whatever happens.
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

// ------------------------------------------------------------------ parsing

/**
 * The fields of a Stripe event this product reads, out of the verified body.
 *
 * Only two event types are acted on, and anything else is accepted and
 * ignored: section 6.6 subscribes to `checkout.session.completed` and
 * `charge.refunded`, and an endpoint that 400s on an event type Stripe decides
 * to add would make Stripe retry it for three days.
 */
export function parseStripeEvent(rawBody: string): StripeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ApiError({ code: "bad-request", message: "That webhook body was not valid JSON." });
  }
  const event = parsed as {
    id?: unknown;
    type?: unknown;
    created?: unknown;
    data?: { object?: Record<string, unknown> };
  };
  const id = typeof event.id === "string" ? event.id : null;
  const type = typeof event.type === "string" ? event.type : null;
  if (id === null || type === null) {
    throw new ApiError({
      code: "bad-request",
      message: "That webhook body is not a Stripe event.",
    });
  }
  if (type !== "checkout.session.completed" && type !== "charge.refunded") return null;

  const object = event.data?.object ?? {};
  const userId =
    typeof object["client_reference_id"] === "string"
      ? object["client_reference_id"]
      : metadataUserId(object);
  const amountCents =
    typeof object["amount_total"] === "number"
      ? object["amount_total"]
      : typeof object["amount_refunded"] === "number"
        ? object["amount_refunded"]
        : 0;

  if (userId === null) {
    // Without a user there is nothing to credit, and guessing is worse than
    // failing: Stripe will retry, and a human can look at the event.
    throw new ApiError({
      code: "bad-request",
      message:
        "That Stripe event carries no client_reference_id, so there is no balance to credit.",
    });
  }

  return {
    id,
    type,
    createdAt: typeof event.created === "number" ? event.created * 1000 : 0,
    userId,
    amountCents,
    sessionId: typeof object["id"] === "string" ? object["id"] : null,
  };
}

function metadataUserId(object: Record<string, unknown>): string | null {
  const metadata = object["metadata"];
  if (typeof metadata !== "object" || metadata === null) return null;
  const userId = (metadata as Record<string, unknown>)["userId"];
  return typeof userId === "string" ? userId : null;
}

// --------------------------------------------------------------------- fake

export interface FakeStripeOptions {
  /** So two runs produce the same session ids. */
  readonly idPrefix?: string;
}

/**
 * A Stripe that keeps its sessions in a `Map`.
 *
 * It is not a set of canned responses: it holds state, completes a session when
 * told to, and hands back the event Stripe would have sent, signed with
 * whatever secret the test gives it. That is what makes the webhook path
 * testable end to end without an account.
 */
export class FakeStripeClient implements StripeClient {
  private readonly sessions = new Map<string, StripeCheckoutSession>();
  private readonly events: StripeEvent[] = [];
  private counter = 0;
  private readonly prefix: string;

  constructor(options: FakeStripeOptions = {}) {
    this.prefix = options.idPrefix ?? "cs_test";
  }

  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<StripeCheckoutSession> {
    this.counter += 1;
    const id = `${this.prefix}_${this.counter.toString().padStart(4, "0")}`;
    const session: StripeCheckoutSession = {
      id,
      url: `https://checkout.stripe.com/c/pay/${id}`,
      amountCents: input.amountCents,
      clientReferenceId: input.userId,
      status: "open",
    };
    this.sessions.set(id, session);
    return Promise.resolve(session);
  }

  retrieveSession(sessionId: string): Promise<StripeCheckoutSession | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null);
  }

  listEvents(sinceSeconds: number): Promise<StripeEvent[]> {
    return Promise.resolve(
      this.events
        .filter((event) => event.createdAt >= sinceSeconds * 1000)
        .sort((a, b) => b.createdAt - a.createdAt),
    );
  }

  /** What the customer finishing the hosted page does, on Stripe's side. */
  complete(sessionId: string, now: number): { rawBody: string; event: StripeEvent } {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`no fake session ${sessionId}`);
    this.sessions.set(sessionId, { ...session, status: "complete" });
    this.counter += 1;
    const id = `evt_test_${this.counter.toString().padStart(4, "0")}`;
    const rawBody = JSON.stringify({
      id,
      type: "checkout.session.completed",
      created: Math.floor(now / 1000),
      data: {
        object: {
          id: sessionId,
          client_reference_id: session.clientReferenceId,
          amount_total: session.amountCents,
          metadata: { userId: session.clientReferenceId },
        },
      },
    });
    const event: StripeEvent = {
      id,
      type: "checkout.session.completed",
      createdAt: now,
      userId: session.clientReferenceId,
      amountCents: session.amountCents,
      sessionId,
    };
    this.events.push(event);
    return { rawBody, event };
  }

  /** A refund issued in the Stripe dashboard (section 6.6). */
  refund(sessionId: string, amountCents: number, now: number): { rawBody: string } {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`no fake session ${sessionId}`);
    this.counter += 1;
    const id = `evt_test_${this.counter.toString().padStart(4, "0")}`;
    const rawBody = JSON.stringify({
      id,
      type: "charge.refunded",
      created: Math.floor(now / 1000),
      data: {
        object: {
          id: sessionId,
          amount_refunded: amountCents,
          metadata: { userId: session.clientReferenceId },
        },
      },
    });
    this.events.push({
      id,
      type: "charge.refunded",
      createdAt: now,
      userId: session.clientReferenceId,
      amountCents,
      sessionId,
    });
    return { rawBody };
  }
}

// --------------------------------------------------------------------- http

/**
 * The real client, over `fetch`, and **never run**.
 *
 * Three calls, form-encoded as Stripe's API expects, with the parameters
 * section 6.6 names: payment mode, the user id in `client_reference_id`, the
 * amount in metadata. It is here so the shape is reviewable and so the founder
 * can see exactly what a key would be used for; the first person to run it
 * should expect to find something wrong, because nobody has.
 */
export class HttpStripeClient implements StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly baseUrl = "https://api.stripe.com/v1",
  ) {}

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<StripeCheckoutSession> {
    const body = new URLSearchParams({
      mode: "payment",
      client_reference_id: input.userId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      "metadata[userId]": input.userId,
      "metadata[amountCents]": input.amountCents.toString(),
      // One product, one price per amount (section 6.6). Until the prices exist
      // in the account, an ad-hoc line item is what a test-mode session needs.
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": input.amountCents.toString(),
      "line_items[0][price_data][product_data][name]": "Lexicue balance",
    });
    const session = await this.call<{
      id: string;
      url: string;
      amount_total: number;
      client_reference_id: string;
      status: string;
    }>("POST", "/checkout/sessions", body);
    return {
      id: session.id,
      url: session.url,
      amountCents: session.amount_total,
      clientReferenceId: session.client_reference_id,
      status: session.status === "complete" ? "complete" : "open",
    };
  }

  async retrieveSession(sessionId: string): Promise<StripeCheckoutSession | null> {
    const session = await this.call<{
      id: string;
      url: string;
      amount_total: number;
      client_reference_id: string;
      status: string;
    }>("GET", `/checkout/sessions/${sessionId}`);
    return {
      id: session.id,
      url: session.url,
      amountCents: session.amount_total,
      clientReferenceId: session.client_reference_id,
      status: session.status === "complete" ? "complete" : "open",
    };
  }

  async listEvents(sinceSeconds: number): Promise<StripeEvent[]> {
    const response = await this.call<{ data: unknown[] }>(
      "GET",
      `/events?created[gte]=${Math.floor(sinceSeconds).toString()}&limit=100`,
    );
    const events: StripeEvent[] = [];
    for (const raw of response.data) {
      const event = parseStripeEvent(JSON.stringify(raw));
      if (event !== null) events.push(event);
    }
    return events;
  }

  private async call<T>(method: string, path: string, body?: URLSearchParams): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(body === undefined ? {} : { body: body.toString() }),
    });
    if (!response.ok) {
      // The user never sees a Stripe error message, only that the top-up did
      // not happen; the real one goes to the log (section 2.3).
      throw new ApiError({
        code: "internal",
        message: "The payment page could not be created. Nothing has been charged; try again.",
      });
    }
    return (await response.json()) as T;
  }
}
