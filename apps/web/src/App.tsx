import "./App.css";
import { BackendProvider, useBackend } from "./app/backend.js";
import { DraftProvider } from "./app/draft.js";
import { useMe, useResetDemo, useSession, useSignOut } from "./app/queries.js";
import { useRoute, type Route } from "./app/routes.js";
import type { BackendAdapter } from "./backend/types.js";
import { SignInScreen } from "./features/auth/SignInScreen.js";
import { BatchScreen } from "./features/batch/BatchScreen.js";
import { HistoryScreen } from "./features/history/HistoryScreen.js";
import { UploadScreen } from "./features/upload/UploadScreen.js";
import { CheckoutScreen } from "./features/wallet/CheckoutScreen.js";
import { WalletScreen } from "./features/wallet/WalletScreen.js";
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
    const items: MenuItem[] = [
      {
        id: "wallet",
        label: "Wallet",
        hint: "Balance, top-ups and every transaction",
        onSelect: () => {
          navigate({ name: "wallet" });
        },
      },
      {
        id: "history",
        label: "History",
        hint: "Uploads from the last 30 days",
        onSelect: () => {
          navigate({ name: "history" });
        },
      },
    ];
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

  const badge = badgeFor(backend);

  return (
    <div className="shell">
      <AppHeader
        balance={
          me.data === undefined
            ? null
            : { balanceCents: me.data.balanceCents, freeCents: me.data.freeCents }
        }
        {...(verified
          ? {
              onOpenWallet: () => {
                navigate({ name: "wallet" });
              },
            }
          : {})}
        menuItems={menuItems}
        {...(badge === null ? {} : { demoBadge: badge })}
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

/**
 * What the header says about which backend is answering. The mock is a demo
 * end to end; the local development API translates for real but its wallet is
 * still a simulation, and the user should never be in any doubt which.
 */
function badgeFor(backend: BackendAdapter): string | null {
  if (backend.kind === "mock") return "Demo";
  // Only the local development API offers a reset, so this is development.
  if (backend.demo !== null) return "Local · real translation, simulated money";
  return null;
}

function Screen({ route }: { route: Route }): React.JSX.Element {
  switch (route.name) {
    case "checkout":
      return <CheckoutScreen sessionId={route.sessionId} amountCents={route.amountCents} />;
    case "batch":
      return <BatchScreen batchId={route.batchId} />;
    case "wallet":
      return <WalletScreen />;
    case "history":
      return <HistoryScreen />;
    case "translate":
      return <UploadScreen />;
  }
}
