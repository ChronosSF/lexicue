import { createContext, useContext, useMemo } from "react";
import { createBackend } from "../backend/index.js";
import type { BackendAdapter } from "../backend/types.js";

const BackendContext = createContext<BackendAdapter | null>(null);

/**
 * The one place the app learns which backend it is talking to. Tests pass a
 * mock backend built with their own clock and storage; the app builds one from
 * `VITE_BACKEND`.
 */
export function BackendProvider({
  backend,
  children,
}: {
  backend?: BackendAdapter;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo(() => backend ?? createBackend(), [backend]);
  return <BackendContext.Provider value={value}>{children}</BackendContext.Provider>;
}

export function useBackend(): BackendAdapter {
  const backend = useContext(BackendContext);
  if (backend === null) throw new Error("useBackend was called outside a BackendProvider.");
  return backend;
}
