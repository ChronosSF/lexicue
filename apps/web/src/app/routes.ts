import { useCallback, useEffect, useState } from "react";

/**
 * The app is one page with a handful of states, so the router is a reading of
 * `location.hash` and nothing more. It earns its keep twice: the browser's back
 * button works, and the mock checkout can hand back a URL the way Stripe hands
 * back a hosted one.
 */

export type Route =
  | { name: "translate" }
  | { name: "batch"; batchId: string }
  | { name: "wallet" }
  | { name: "history" }
  | { name: "checkout"; sessionId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [head, tail] = parts;
  if (head === "batch" && tail !== undefined) return { name: "batch", batchId: tail };
  if (head === "checkout" && tail !== undefined) return { name: "checkout", sessionId: tail };
  if (head === "wallet") return { name: "wallet" };
  if (head === "history") return { name: "history" };
  return { name: "translate" };
}

export function hashFor(route: Route): string {
  switch (route.name) {
    case "translate":
      return "#/";
    case "batch":
      return `#/batch/${route.batchId}`;
    case "wallet":
      return "#/wallet";
    case "history":
      return "#/history";
    case "checkout":
      return `#/checkout/${route.sessionId}`;
  }
}

export function useRoute(): { route: Route; navigate: (to: Route | string) => void } {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onChange = (): void => {
      setHash(window.location.hash);
    };
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
    };
  }, []);

  const navigate = useCallback((to: Route | string) => {
    const next = typeof to === "string" ? to : hashFor(to);
    if (window.location.hash === next) {
      setHash(next);
      return;
    }
    window.location.hash = next;
  }, []);

  return { route: parseRoute(hash), navigate };
}
