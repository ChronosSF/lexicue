#!/usr/bin/env node
import process from "node:process";
import { main } from "./main.js";

const code = await main(process.argv.slice(2), {
  log: (line) => process.stdout.write(`${line}\n`),
  logError: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
});

process.exitCode = code;
