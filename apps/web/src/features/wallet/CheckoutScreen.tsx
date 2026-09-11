import { formatCents } from "@lexicue/pricing";
import { useEffect, useState } from "react";
import { useCompleteCheckout, useMe } from "../../app/queries.js";
import { useRoute } from "../../app/routes.js";
import "./CheckoutScreen.css";

/**
 * The mock checkout. In the deployed product this is Stripe's hosted page and
 * the balance moves when Stripe's webhook lands, usually within seconds; the
 * page shows "Payment received, updating balance" and keeps polling rather than
 * showing a stale number (spec section 2.2). That is exactly what happens here,
 * except that the confirm button plays the part of the card form.
 */
export function CheckoutScreen({
  sessionId,
  amountCents,
}: {
  sessionId: string;
  amountCents: number;
}): React.JSX.Element {
  const { navigate } = useRoute();
  const complete = useCompleteCheckout();
  const [waiting, setWaiting] = useState(false);
  const [balanceBefore, setBalanceBefore] = useState<number | null>(null);
  const me = useMe(true, waiting ? 400 : false);

  const credited =
    waiting &&
    balanceBefore !== null &&
    (me.data?.balanceCents ?? 0) >= balanceBefore + amountCents;

  useEffect(() => {
    if (!credited) return undefined;
    const timer = window.setTimeout(() => {
      navigate({ name: "translate" });
    }, 1_200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [credited, navigate]);

  if (credited) {
    return (
      <section className="card card-pad checkout">
        <p className="eyebrow">Payment received</p>
        <h1>{formatCents(amountCents)} added to your balance</h1>
        <p className="muted">
          Your balance is now {formatCents(me.data?.balanceCents ?? 0)}. Back to your files…
        </p>
      </section>
    );
  }

  if (waiting) {
    return (
      <section className="card card-pad checkout" aria-live="polite">
        <p className="eyebrow">Payment received</p>
        <h1>Updating your balance</h1>
        <p className="muted">
          This takes a second or two: the payment is confirmed and the balance follows.
        </p>
        <div className="bar checkout-bar">
          <i style={{ width: "60%" }} />
        </div>
      </section>
    );
  }

  return (
    <section className="card card-pad checkout">
      <p className="eyebrow">Checkout · demo</p>
      <h1>Add {formatCents(amountCents)} to your balance</h1>
      <p className="muted">
        The real product sends you to Stripe’s hosted Checkout here, so card details never touch
        this app’s servers. This page stands in for it: no card, no charge, no network.
      </p>

      <dl className="checkout-lines">
        <div>
          <dt>Translation balance</dt>
          <dd className="num">{formatCents(amountCents)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd className="num checkout-total">{formatCents(amountCents)}</dd>
        </div>
      </dl>

      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={complete.isPending}
          onClick={() => {
            setBalanceBefore(me.data?.balanceCents ?? 0);
            complete.mutate(sessionId, {
              onSuccess: () => {
                setWaiting(true);
              },
            });
          }}
        >
          Pay {formatCents(amountCents)}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            navigate({ name: "translate" });
          }}
        >
          Cancel
        </button>
      </div>

      <p className="hint">
        Balances buy translations on this service only. They do not expire and are not transferable.
      </p>
    </section>
  );
}
