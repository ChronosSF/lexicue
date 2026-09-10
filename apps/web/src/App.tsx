import "./App.css";
import { BackendProvider, useBackend } from "./app/backend.js";
import { useMe, useResetDemo, useSession, useSignOut } from "./app/queries.js";
import { useRoute } from "./app/routes.js";
import type { BackendAdapter } from "./backend/types.js";
import { SignInScreen } from "./features/auth/SignInScreen.js";
import { UploadScreen } from "./features/upload/UploadScreen.js";
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
      <Shell />
    </BackendProvider>
  );
}

function Shell(): React.JSX.Element {
  const backend = useBackend();
  const { navigate } = useRoute();
  const session = useSession();
  const signedIn = session.data ?? null;
  const me = useMe(signedIn?.emailVerified === true);
  const signOut = useSignOut();
  const reset = useResetDemo();

  const menuItems: MenuItem[] = signedIn === null ? [] : buildMenu();

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
        onOpenWallet={() => {
          navigate({ name: "wallet" });
        }}
        menuItems={menuItems}
        {...(backend.kind === "mock" ? { demoBadge: "Demo" } : {})}
      />

      <main className="container main">
        {session.isPending ? (
          <p className="muted">Loading…</p>
        ) : !signedIn?.emailVerified ? (
          <SignInScreen session={signedIn} />
        ) : (
          <UploadScreen />
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
