import { TOP_UP_AMOUNTS_CENTS } from "@lexicue/pricing";
import { describe, expect, it } from "vitest";
import { emptyState, type MockState } from "./state.js";
import {
  applyCharge,
  applyGrant,
  applyRefund,
  applyTopUp,
  insufficientBalance,
  ledgerBalance,
  splitFreeFirst,
  suggestTopUp,
} from "./wallet.js";

/** The wallet arithmetic of spec sections 6.3, 6.5 and 7.4. */

const NOW = Date.parse("2026-09-10T12:00:00.000Z");

function funded(): MockState {
  const state = emptyState();
  applyGrant(state, 250, NOW);
  applyTopUp(state, { amountCents: 1000, ref: "cs_1", now: NOW });
  return state;
}

describe("free before paid", () => {
  it("splits a charge across the grant and the paid balance", () => {
    expect(splitFreeFirst(420, 250)).toEqual({ fromFree: 250, fromPaid: 170 });
    expect(splitFreeFirst(120, 250)).toEqual({ fromFree: 120, fromPaid: 0 });
    expect(splitFreeFirst(420, 0)).toEqual({ fromFree: 0, fromPaid: 420 });
  });

  it("spends the free balance first and records the split", () => {
    const state = funded();
    const { entry, fromFree, fromPaid } = applyCharge(state, {
      totalCents: 420,
      ref: "bat_1",
      description: "Translated 8 files into German",
      now: NOW,
    });

    expect(fromFree).toBe(250);
    expect(fromPaid).toBe(170);
    expect(state.balanceCents).toBe(830);
    expect(state.freeCents).toBe(0);
    expect(entry).toMatchObject({ deltaCents: -420, freeDeltaCents: -250, balanceAfter: 830 });
  });

  it("puts the free portion back when a file is refunded", () => {
    const state = funded();
    applyCharge(state, { totalCents: 100, ref: "bat_1", description: "Translated", now: NOW });
    expect(state.freeCents).toBe(150);

    applyRefund(state, {
      amountCents: 100,
      freeCents: 100,
      ref: "job_1",
      description: "Refund for fail.srt",
      now: NOW,
    });
    expect(state.balanceCents).toBe(1250);
    expect(state.freeCents).toBe(250);
  });

  it("never charges without the balance to cover it", () => {
    const state = emptyState();
    expect(() =>
      applyCharge(state, { totalCents: 10, ref: "bat_1", description: "x", now: NOW }),
    ).toThrow();
  });
});

describe("the ledger", () => {
  it("always sums to the balance, whatever the sequence", () => {
    const state = funded();
    applyCharge(state, { totalCents: 180, ref: "bat_1", description: "a", now: NOW });
    applyTopUp(state, { amountCents: 500, ref: "cs_2", now: NOW });
    applyCharge(state, { totalCents: 90, ref: "bat_2", description: "b", now: NOW });
    applyRefund(state, {
      amountCents: 90,
      freeCents: 70,
      ref: "job_2",
      description: "c",
      now: NOW,
    });
    applyCharge(state, { totalCents: 1000, ref: "bat_3", description: "d", now: NOW });

    expect(ledgerBalance(state)).toBe(state.balanceCents);
    expect(state.balanceCents).toBeGreaterThanOrEqual(0);
    expect(state.freeCents).toBeLessThanOrEqual(state.balanceCents);
  });
});

describe("the 402", () => {
  it("names the shortfall and the smallest top-up that covers it", () => {
    const error = insufficientBalance(420, 120, TOP_UP_AMOUNTS_CENTS);
    expect(error.status).toBe(402);
    if (!error.is("insufficient-balance")) throw new Error("expected a 402");
    expect(error.body.shortfallCents).toBe(300);
    expect(error.body.suggestedTopUpCents).toBe(500);
    expect(error.message).toContain("$4.20");
    expect(error.message).toContain("$1.20");
    expect(error.message).toContain("$3.00");
  });

  it("suggests the largest amount when nothing covers the shortfall", () => {
    expect(suggestTopUp(50, TOP_UP_AMOUNTS_CENTS)).toBe(500);
    expect(suggestTopUp(1200, TOP_UP_AMOUNTS_CENTS)).toBe(2500);
    expect(suggestTopUp(9000, TOP_UP_AMOUNTS_CENTS)).toBe(2500);
  });
});
