import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  // One test builds the app for production and runs in a Node environment,
  // where there is no document to clean up.
  if (typeof window === "undefined") return;
  cleanup();
  window.localStorage.clear();
});
