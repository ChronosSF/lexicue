import { formatCents } from "@subtitle-translator/pricing";
import type { LedgerEntry } from "@subtitle-translator/shared";
import { useState } from "react";
import { useMe, usePricing, useTopUp } from "../../app/queries.js";
import { useRoute } from "../../app/routes.js";
import { formatDateTime } from "../../ui/format.js";
import "./WalletScreen.css";

/**
 * The wallet of spec section 2.2: the balance in money with the free portion
 * marked while it lasts, the three top-up amounts with $10 preselected, and
 * every movement of money since the account was made. Prices are never shown as
 * credits, so there is nothing to convert in one's head.
 */
export function WalletScreen(): React.JSX.Element {
  const me = useMe();
  const pricing = usePricing();
  const topUp = useTopUp();
  const { navigate } = useRoute();
  const [amount, setAmount] = useState<number | null>(null);

  const amounts = pricing.data?.topUpAmountsCents ?? [500, 1000, 2500];
  const chosen = amount ?? pricing.data?.defaultTopUpCents ?? 1000;

  return (
    <div className="wallet stack-lg">
      <header className="stack">
        <p className="eyebrow">Wallet</p>
        <h1 className="wallet-balance num">{formatCents(me.data?.balanceCents ?? 0)}</h1>
        {me.data !== undefined && me.data.freeCents > 0 ? (
          <p className="muted">
            Including <strong>{formatCents(me.data.freeCents)}</strong> of free credit, which is
            spent before anything you have paid for.
          </p>
        ) : (
          <p className="muted">Every file is charged at the price shown before you confirm.</p>
        )}
      </header>

      <section className="card card-pad topup">
        <h2 className="card-title">Add to your balance</h2>
        <div className="topup-amounts" role="radiogroup" aria-label="Top-up amount">
          {amounts.map((value) => (
            <label
              key={value}
              className={value === chosen ? "topup-amount is-chosen" : "topup-amount"}
            >
              <input
                type="radio"
                name="amount"
                className="visually-hidden"
                value={value}
                checked={value === chosen}
                onChange={() => {
                  setAmount(value);
                }}
              />
              <span className="topup-value num">{formatCents(value)}</span>
              <span className="topup-detail faint">{examplesFor(value)}</span>
            </label>
          ))}
        </div>

        <div className="row">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={topUp.isPending}
            onClick={() => {
              topUp.mutate(
                { amountCents: chosen },
                {
                  onSuccess: (session) => {
                    navigate(session.checkoutUrl);
                  },
                },
              );
            }}
          >
            Continue to checkout
          </button>
          <p className="hint topup-hint">
            Card details never touch this app: the real product hands you to Stripe’s hosted
            Checkout and the balance moves when the payment is confirmed.
          </p>
        </div>
        {topUp.error === null ? null : <p className="problem">{topUp.error.message}</p>}
      </section>

      <section className="card transactions">
        <div className="card-head">
          <h2 className="card-title">Transactions</h2>
          <span className="muted">Kept for 30 days</span>
        </div>
        {me.data === undefined || me.data.transactions.length === 0 ? (
          <p className="card-pad muted">Nothing has moved yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col" className="right">
                    Amount
                  </th>
                  <th scope="col" className="right">
                    Balance
                  </th>
                </tr>
              </thead>
              <tbody>
                {me.data.transactions.map((entry) => (
                  <TransactionRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function TransactionRow({ entry }: { entry: LedgerEntry }): React.JSX.Element {
  const positive = entry.deltaCents >= 0;
  return (
    <tr>
      <td className="muted">{formatDateTime(entry.at)}</td>
      <td>
        <span className="transaction-what">{entry.description}</span>
        <span className={`chip ${chipFor(entry.reason)} transaction-kind`}>
          {label(entry.reason)}
        </span>
        {entry.freeDeltaCents !== 0 && entry.reason === "charge" ? (
          <span className="faint transaction-free">
            {formatCents(-entry.freeDeltaCents)} from free credit
          </span>
        ) : null}
      </td>
      <td className={positive ? "right num transaction-up" : "right num"}>
        {positive ? "+" : ""}
        {formatCents(entry.deltaCents)}
      </td>
      <td className="right num muted">{formatCents(entry.balanceAfter)}</td>
    </tr>
  );
}

function label(reason: LedgerEntry["reason"]): string {
  switch (reason) {
    case "topup":
      return "Top-up";
    case "grant":
      return "Free credit";
    case "charge":
      return "Translation";
    case "refund":
      return "Refund";
  }
}

function chipFor(reason: LedgerEntry["reason"]): string {
  switch (reason) {
    case "topup":
      return "chip-info";
    case "grant":
      return "chip-accent";
    case "charge":
      return "";
    case "refund":
      return "chip-ok";
  }
}

/** What each amount buys, in files rather than in credits (spec section 6.1). */
function examplesFor(amountCents: number): string {
  const episodes = Math.floor(amountCents / 48);
  const films = Math.floor(amountCents / 180);
  return `About ${episodes.toString()} sitcom episodes, or ${films.toString()} feature films, on the fast lane`;
}
