import { formatCents } from "@subtitle-translator/pricing";
import { ApiError, type LedgerEntry, type LedgerReason } from "@subtitle-translator/shared";
import { newId, type MockState } from "./state.js";

/**
 * The wallet rules of spec sections 6.3, 6.5 and 7.4. Every movement writes one
 * append-only ledger entry carrying the balance after it, the free portion is
 * always spent before paid balance, and the balance can never go below zero.
 */

/** How a charge divides between the free grant and paid balance. */
export function splitFreeFirst(
  totalCents: number,
  freeCents: number,
): { fromFree: number; fromPaid: number } {
  const fromFree = Math.min(totalCents, freeCents);
  return { fromFree, fromPaid: totalCents - fromFree };
}

/** The smallest offered top-up that covers a shortfall (spec section 2.1). */
export function suggestTopUp(shortfallCents: number, amountsCents: readonly number[]): number {
  const sorted = [...amountsCents].sort((a, b) => a - b);
  return sorted.find((amount) => amount >= shortfallCents) ?? sorted.at(-1) ?? 0;
}

function record(
  state: MockState,
  entry: {
    reason: LedgerReason;
    deltaCents: number;
    freeDeltaCents: number;
    ref: string | null;
    description: string;
    now: number;
  },
): LedgerEntry {
  const ledgerEntry: LedgerEntry = {
    id: newId("led"),
    at: new Date(entry.now).toISOString(),
    deltaCents: entry.deltaCents,
    reason: entry.reason,
    ref: entry.ref,
    description: entry.description,
    balanceAfter: state.balanceCents,
    freeDeltaCents: entry.freeDeltaCents,
  };
  state.ledger.push(ledgerEntry);
  return ledgerEntry;
}

/** The one-off $2.50 a verified email receives (spec section 6.5). */
export function applyGrant(state: MockState, amountCents: number, now: number): LedgerEntry {
  state.balanceCents += amountCents;
  state.freeCents += amountCents;
  return record(state, {
    reason: "grant",
    deltaCents: amountCents,
    freeDeltaCents: amountCents,
    ref: null,
    description: "Free starting balance",
    now,
  });
}

export function applyTopUp(
  state: MockState,
  input: { amountCents: number; ref: string; now: number },
): LedgerEntry {
  state.balanceCents += input.amountCents;
  return record(state, {
    reason: "topup",
    deltaCents: input.amountCents,
    freeDeltaCents: 0,
    ref: input.ref,
    description: `Top-up of ${formatCents(input.amountCents)}`,
    now: input.now,
  });
}

/**
 * The charging transaction of spec section 7.4: it either takes the whole
 * amount or it takes nothing, and it records how much of it was free.
 */
export function applyCharge(
  state: MockState,
  input: { totalCents: number; ref: string; description: string; now: number },
): { entry: LedgerEntry; fromFree: number; fromPaid: number } {
  if (state.balanceCents < input.totalCents) {
    throw new Error("applyCharge called without checking the balance");
  }
  const split = splitFreeFirst(input.totalCents, state.freeCents);
  state.balanceCents -= input.totalCents;
  state.freeCents -= split.fromFree;
  const entry = record(state, {
    reason: "charge",
    deltaCents: -input.totalCents,
    freeDeltaCents: -split.fromFree,
    ref: input.ref,
    description: input.description,
    now: input.now,
  });
  return { entry, ...split };
}

/**
 * A file that fails is refunded automatically (spec section 2.3). The free
 * portion of its charge goes back to the free balance, so a trial user who hits
 * a failure has lost nothing at all.
 */
export function applyRefund(
  state: MockState,
  input: {
    amountCents: number;
    freeCents: number;
    ref: string;
    description: string;
    now: number;
  },
): LedgerEntry {
  state.balanceCents += input.amountCents;
  state.freeCents += input.freeCents;
  return record(state, {
    reason: "refund",
    deltaCents: input.amountCents,
    freeDeltaCents: input.freeCents,
    ref: input.ref,
    description: input.description,
    now: input.now,
  });
}

/** The 402 of spec section 7.3, written as the sentence the user reads. */
export function insufficientBalance(
  totalCents: number,
  balanceCents: number,
  topUpAmountsCents: readonly number[],
): ApiError {
  const shortfallCents = totalCents - balanceCents;
  const suggestedTopUpCents = suggestTopUp(shortfallCents, topUpAmountsCents);
  return new ApiError({
    code: "insufficient-balance",
    message: `This upload costs ${formatCents(totalCents)} and your balance is ${formatCents(
      balanceCents,
    )}. Top up ${formatCents(suggestedTopUpCents)} to cover the ${formatCents(
      shortfallCents,
    )} difference.`,
    totalCents,
    balanceCents,
    shortfallCents,
    suggestedTopUpCents,
  });
}

/** The invariant the nightly reconciliation of spec section 8 asserts. */
export function ledgerBalance(state: MockState): number {
  return state.ledger.reduce((sum, entry) => sum + entry.deltaCents, 0);
}
