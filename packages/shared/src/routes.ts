import type { z } from "zod";
import {
  BatchListResponseSchema,
  BatchResponseSchema,
  CreateBatchRequestSchema,
  CreateBatchResponseSchema,
} from "./batches.js";
import { LanguagesResponseSchema, PricingResponseSchema } from "./catalogue.js";
import { MeResponseSchema } from "./me.js";
import {
  CreateUploadsRequestSchema,
  CreateUploadsResponseSchema,
  TopUpRequestSchema,
  TopUpResponseSchema,
} from "./uploads.js";

/**
 * Spec section 7.3 as data. Every route names the schema of what it accepts and
 * the schema of what it returns, so the real backend adapter is a loop over
 * this table rather than a dozen hand-written `fetch` calls, and the Phase 2
 * handlers can validate against the same objects.
 */

export type HttpMethod = "GET" | "POST" | "DELETE";
export type RouteAuth = "jwt" | "none" | "stripe-signature";

export interface RouteDefinition {
  method: HttpMethod;
  /** The path, with `{id}` where a parameter goes. */
  path: string;
  auth: RouteAuth;
  request: z.ZodType | null;
  response: z.ZodType | null;
  summary: string;
}

export const API_ROUTES = {
  getMe: {
    method: "GET",
    path: "/api/me",
    auth: "jwt",
    request: null,
    response: MeResponseSchema,
    summary: "Balance (total and free portion), limits, recent batches and transactions",
  },
  deleteMe: {
    method: "DELETE",
    path: "/api/me",
    auth: "jwt",
    request: null,
    response: null,
    summary: "Account deletion; the hashed email survives to enforce one free balance",
  },
  getPricing: {
    method: "GET",
    path: "/api/pricing",
    auth: "none",
    request: null,
    response: PricingResponseSchema,
    summary: "Rates per lane, minimum price, top-up amounts and worked examples",
  },
  getLanguages: {
    method: "GET",
    path: "/api/languages",
    auth: "none",
    request: null,
    response: LanguagesResponseSchema,
    summary: "Target language list with regional variants",
  },
  createUploads: {
    method: "POST",
    path: "/api/uploads",
    auth: "jwt",
    request: CreateUploadsRequestSchema,
    response: CreateUploadsResponseSchema,
    summary: "Presigned POSTs for 1 to 50 files, at most 5 MB each and 25 MB in total",
  },
  createBatch: {
    method: "POST",
    path: "/api/batches",
    auth: "jwt",
    request: CreateBatchRequestSchema,
    response: CreateBatchResponseSchema,
    summary: "Price every file, charge the wallet and enqueue the work; 202, 402 or 422",
  },
  getBatch: {
    method: "GET",
    path: "/api/batches/{id}",
    auth: "jwt",
    request: null,
    response: BatchResponseSchema,
    summary: "Batch status, per-file progress, download URLs and reports",
  },
  listBatches: {
    method: "GET",
    path: "/api/batches",
    auth: "jwt",
    request: null,
    response: BatchListResponseSchema,
    summary: "History for 30 days",
  },
  deleteBatch: {
    method: "DELETE",
    path: "/api/batches/{id}",
    auth: "jwt",
    request: null,
    response: null,
    summary: "Delete the batch's files immediately; metadata stays until its TTL",
  },
  createTopUp: {
    method: "POST",
    path: "/api/billing/topup",
    auth: "jwt",
    request: TopUpRequestSchema,
    response: TopUpResponseSchema,
    summary: "Checkout session for $5, $10 or $25; returns the hosted URL",
  },
  billingWebhook: {
    method: "POST",
    path: "/api/billing/webhook",
    auth: "stripe-signature",
    request: null,
    response: null,
    summary: "Balance and ledger updates, idempotent per event id",
  },
} as const satisfies Record<string, RouteDefinition>;

export type RouteName = keyof typeof API_ROUTES;

/** Fills `{id}` in a route path. */
export function routePath(name: RouteName, params: Record<string, string> = {}): string {
  return API_ROUTES[name].path.replace(/\{(\w+)\}/g, (whole, key: string) => params[key] ?? whole);
}
