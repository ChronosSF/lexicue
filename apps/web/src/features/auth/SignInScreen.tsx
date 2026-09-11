import { formatCents } from "@lexicue/pricing";
import { useState } from "react";
import { useSignIn, useVerifyEmail } from "../../app/queries.js";
import { usePricing } from "../../app/queries.js";
import type { Session } from "../../backend/types.js";
import "./SignInScreen.css";

/**
 * Sign-in and the verification step of spec section 2.1. Verification is what
 * grants the free balance, so it is a step in the flow rather than an email the
 * user has to go and find: in the demo the link is a button.
 */
export function SignInScreen({ session }: { session: Session | null }): React.JSX.Element {
  const [email, setEmail] = useState("");
  const signIn = useSignIn();
  const verify = useVerifyEmail();
  const pricing = usePricing();
  const freeCents = pricing.data?.freeBalanceCents ?? 250;

  if (session !== null && !session.emailVerified) {
    return (
      <section className="card card-pad auth">
        <h1>Check your email</h1>
        <p className="auth-lead">
          A verification link is on its way to <strong>{session.email}</strong>. Verifying puts{" "}
          {formatCents(freeCents)} of free translations in your balance, which is a feature film
          plus an episode.
        </p>
        <p className="hint">
          This demo has no mail server, so the button below stands in for the link.
        </p>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={verify.isPending}
            onClick={() => {
              verify.mutate();
            }}
          >
            {verify.isPending ? "Verifying…" : "I have verified my email"}
          </button>
        </div>
        {verify.error === null ? null : <p className="problem">{verify.error.message}</p>}
      </section>
    );
  }

  return (
    <section className="card card-pad auth">
      <h1>Sign in</h1>
      <p className="auth-lead">
        Email and password in the deployed product, through Cognito. In this demo any address works
        and there is no password.
      </p>
      <form
        className="auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          signIn.mutate({ email });
        }}
      >
        <div className="field">
          <label className="label" htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary btn-lg" disabled={signIn.isPending}>
          {signIn.isPending ? "Signing in…" : "Continue"}
        </button>
      </form>
      {signIn.error === null ? null : <p className="problem">{signIn.error.message}</p>}
    </section>
  );
}
