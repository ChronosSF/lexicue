#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./env-file.js";
import { main } from "./main.js";

const logError = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

// The key for this checkout lives in .env at the repository root, three
// levels up from this file whether it runs from src or from dist.
const envFile = loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)), process.env);
for (const key of envFile.overridden) {
  logError(`${key} from ${envFile.path} overrides the value in the environment.`);
}

const code = await main(process.argv.slice(2), {
  log: (line) => process.stdout.write(`${line}\n`),
  logError,
  env: process.env,
});

process.exitCode = code;
