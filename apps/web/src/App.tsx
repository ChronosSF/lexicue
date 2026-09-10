import "./App.css";
import { BackendProvider, useBackend } from "./app/backend.js";
import { DraftProvider } from "./app/draft.js";
import { useMe, useResetDemo, useSession, useSignOut } from "./app/queries.js";
import { useRoute, type Route } from "./app/routes.js";
import type { BackendAdapter } from "./backend/types.js";
import { SignInScreen } from "./features/auth/SignInScreen.js";
import { UploadScreen } from "./features/upload/UploadScreen.js";
import { CheckoutScreen } from "./features/wallet/CheckoutScreen.js";
import { AppHeader } from "./ui/AppHeader.js";
import type { MenuItem } from "./ui/Menu.js";

/**
 * The single page of spec section 2. The shell is deliberately thin: a header
 * with the balance and one menu, a main region that holds whichever state the
 * upload is in, and a footer that states the retention rule the product sells.
 */
export function App({ backend }: { backend?: BackendAdapter }): React.JSX.Element {
  return (
    <BackendProvider {...(backend === undefined ? {} : { backend })}>
      <DraftProvider>
        <Shell />
      </DraftProvider>
    </BackendProvider>
  );
}

function Shell(): React.JSX.Element {
  const backend = useBackend();
  const { route, navigate } = useRoute();
  const session = useSession();
  const signedIn = session.data ?? null;
  const verified = signedIn?.emailVerified === true;
  const me = useMe(verified);
  const signOut = useSignOut();
  const reset = useResetDemo();

  const menuItems: MenuItem[] = verified ? buildMenu() : [];

  function buildMenu(): MenuItem[] {
    const items: MenuItem[] = [];
    if (backend.demo !== null) {
      items.push({
        id: "reset",
        label: "Reset the demo",
        hint: "Back to the starting balance and history",
        onSelect: () => {
          reset.mutate();
          navigate({ name: "translate" });
        },
      });
    }
    items.push({
      id: "sign-out",
      label: "Sign out",
      hint: signedIn?.email ?? "",
      tone: "danger",
      onSelect: () => {
        signOut.mutate();
        navigate({ name: "translate" });
      },
    });
    return items;
  }

  return (
    <div className="shell">
      <AppHeader
        balance={
          me.data === undefined
            ? null
            : { balanceCents: me.data.balanceCents, freeCents: me.data.freeCents }
        }
        menuItems={menuItems}
        {...(backend.kind === "mock" ? { demoBadge: "Demo" } : {})}
      />

      <main className="container main">
        {session.isPending ? (
          <p className="muted">Loading…</p>
        ) : !verified ? (
          <SignInScreen session={signedIn} />
        ) : (
          <Screen route={route} />
        )}
      </main>

      <footer className="container app-footer">
        <p className="faint">
          Uploaded and translated files are deleted 24 hours after a job finishes. History is kept
          for 30 days.
        </p>
      </footer>
    </div>
  );
}

function Screen({ route }: { route: Route }): React.JSX.Element {
  switch (route.name) {
    case "checkout":
      return <CheckoutScreen sessionId={route.sessionId} amountCents={route.amountCents} />;
    case "batch":
    case "wallet":
    case "history":
    case "translate":
      return <UploadScreen />;
  }
}
