#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_API_PORT, missingKeyMessage, resolveApiKey } from "./env.js";

/**
 * `pnpm dev`: the local API and the web app, one command, both gone when you
 * press Ctrl+C.
 *
 * The key is checked here, before anything starts, so a missing one is a clear
 * sentence naming `.env.example` rather than a browser full of failed requests
 * or a silent fall back to the mock.
 *
 * The API is started first and the app only once it is answering. Vite steps to
 * the next free port when 5173 is taken, and the next free port is the API's, so
 * starting them together is a race the API loses.
 */

const { apiKey } = resolveApiKey(process.env);
if (apiKey === null) {
  process.stderr.write(`${missingKeyMessage()}\n`);
  process.exit(1);
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
const apiPort = Number(process.env["LEXICUE_API_PORT"] ?? DEFAULT_API_PORT.toString());
const children: ChildProcess[] = [];
let stopping = false;

/**
 * The command is a single string rather than a command plus an argument array,
 * because passing an array with `shell: true` is what Node's DEP0190 warns
 * about. Nothing here comes from anywhere but this file.
 */
function start(name: string, command: string): ChildProcess {
  const child = spawn(command, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, LEXICUE_API_PORT: apiPort.toString() },
  });
  child.on("exit", (code) => {
    if (stopping) return;
    process.stderr.write(`\n${name} exited with code ${String(code ?? 0)}; stopping the rest.\n`);
    stop(code ?? 1);
  });
  children.push(child);
  return child;
}

function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  process.exitCode = code;
}

/** Resolves when the API answers, or false if it gave up first. */
async function waitForApi(api: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) return false;
    try {
      const response = await fetch(`http://localhost:${apiPort.toString()}/api/pricing`);
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  process.stderr.write(`The local API did not answer on port ${apiPort.toString()}.\n`);
  return false;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop(0);
  });
}

const api = start("The local API", "pnpm exec tsx packages/dev-api/src/bin.ts");
if (await waitForApi(api)) {
  start("The web app", "pnpm --filter web dev");
} else {
  stop(1);
}
