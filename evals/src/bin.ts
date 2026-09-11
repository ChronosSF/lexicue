#!/usr/bin/env node
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnvFile } from "@lexicue/cli";
import { isLane } from "@lexicue/pricing";
import { AnthropicTranslationClient, type TranslationModelClient } from "@lexicue/harness";
import { EVAL_TARGETS } from "./corpus.js";
import { FakeJudgeModelClient } from "./fake-judge.js";
import { runEval, summarise, writeResults } from "./runner.js";

const HELP = `evals run [options]

Runs the evaluation of specification section 10.4 over the corpus in
evals/corpus: every file into every target on one lane, the hard metrics that
must be perfect, the advisory metrics, the LLM judge on a stratified sample of
cues, and the cross-episode consistency check on the season.

Options
  --fake                 Use the deterministic fake model and judge; no key needed
  --to <codes>           Comma-separated targets (default: ${EVAL_TARGETS.join(",")})
  --lane fast|economy    Delivery lane (default: fast)
  --model <id>           Translation model id
  --judge-model <id>     Judge model id (default: claude-opus-5)
  --sample <n>           Cues judged per file (default: 20)
  --no-judge             Structure and cost only; no judge calls
  --only <text>          Restrict the corpus to paths containing this text
  --out <dir>            Results directory (default: evals/results)
  --label <text>         Names the results folder
  -h, --help             Show this help

Without --fake the runner reads ANTHROPIC_API_KEY from .env at the repository
root, falling back to the environment, and refuses to start if it is not set. A
value in .env wins, so this checkout always uses its own key. A full run against
the real model costs about $25 to $35 (specification section 10.4).
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      fake: { type: "boolean" },
      to: { type: "string" },
      lane: { type: "string" },
      model: { type: "string" },
      "judge-model": { type: "string" },
      sample: { type: "string" },
      "no-judge": { type: "boolean" },
      only: { type: "string" },
      out: { type: "string" },
      label: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help === true || positionals[0] !== "run") {
    process.stdout.write(HELP);
    return positionals.length === 0 || values.help === true ? 0 : 2;
  }

  const lane = values.lane ?? "fast";
  if (!isLane(lane)) {
    process.stderr.write(`--lane must be "fast" or "economy", not "${lane}".\n`);
    return 2;
  }

  let client: TranslationModelClient;
  if (values.fake === true) {
    client = new FakeJudgeModelClient();
  } else {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (apiKey === undefined || apiKey.trim() === "") {
      process.stderr.write(
        "ANTHROPIC_API_KEY is not set. Copy .env.example to .env at the repository root and paste the key there, or export it, or add --fake to exercise the runner without spending anything.\n",
      );
      return 2;
    }
    client = new AnthropicTranslationClient({ apiKey });
  }

  const targets = (values.to ?? EVAL_TARGETS.join(",")).split(",").map((code) => code.trim());
  const sample = values.sample === undefined ? undefined : Number(values.sample);

  const result = await runEval({
    client,
    targets,
    lane,
    judge: values["no-judge"] !== true,
    ...(values.model === undefined ? {} : { config: { model: values.model } }),
    ...(values["judge-model"] === undefined ? {} : { judgeModel: values["judge-model"] }),
    ...(sample === undefined ? {} : { judgeSampleSize: sample }),
    ...(values.only === undefined ? {} : { only: values.only }),
    log: (line) => process.stderr.write(`${line}\n`),
  });

  const directory = writeResults(result, {
    root: values.out ?? join("evals", "results"),
    ...(values.label === undefined ? {} : { label: values.label }),
  });
  process.stdout.write(summarise(result));
  process.stdout.write(`\nResults written to ${directory}\n`);
  return result.hardMetricsPassed ? 0 : 1;
}

// The key for this checkout lives in .env at the repository root, two levels
// up from this file whether it runs from src or from dist.
const envFile = loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)), process.env);
for (const key of envFile.overridden) {
  process.stderr.write(`${key} from ${envFile.path} overrides the value in the environment.\n`);
}

process.exitCode = await main();
