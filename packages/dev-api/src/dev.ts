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

function start(name: string, command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
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

start("The local API", "pnpm", ["exec", "tsx", "packages/dev-api/src/bin.ts"]);
start("The web app", "pnpm", ["--filter", "web", "dev"]);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop(0);
  });
}
