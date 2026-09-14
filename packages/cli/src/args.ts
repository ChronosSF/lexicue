import { parseArgs } from "node:util";
import { isLane, type Lane } from "@lexicue/pricing";
import {
  EFFORT_LEVELS,
  MAX_CONTEXT_NOTE_LENGTH,
  findTargetLanguage,
  isEffort,
  type Effort,
  type Formality,
  type LineHandling,
  type TargetLanguage,
} from "@lexicue/harness";

/** Everything `harness translate` was asked to do. */
export interface TranslateCommand {
  kind: "translate";
  files: string[];
  target: TargetLanguage;
  lane: Lane;
  formality: Formality;
  contextNote: string;
  lineHandling: LineHandling;
  translateLyrics: boolean;
  /** Use the deterministic fake client instead of the real API. */
  fake: boolean;
  model: string | undefined;
  /** Pins the model a refused batch is retried on (spec section 4.6). */
  fallbackModel: string | undefined;
  effort: Effort | undefined;
  batchSize: number | undefined;
  concurrency: number | undefined;
  /** Directory for the outputs; by default they go next to the inputs. */
  outDir: string | undefined;
  bom: boolean;
  /** Path to write the JSON report to. */
  reportPath: string | undefined;
}

export interface HelpCommand {
  kind: "help";
}

export type Command = TranslateCommand | HelpCommand;

/** Raised for a command line the tool cannot act on. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const FORMALITIES = new Set<string>(["auto", "formal", "informal"]);

export function parseCommandLine(argv: readonly string[]): Command {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      to: { type: "string" },
      lane: { type: "string" },
      formality: { type: "string" },
      context: { type: "string" },
      model: { type: "string" },
      "fallback-model": { type: "string" },
      effort: { type: "string" },
      "batch-size": { type: "string" },
      concurrency: { type: "string" },
      "line-handling": { type: "string" },
      "no-lyrics": { type: "boolean" },
      out: { type: "string" },
      "no-bom": { type: "boolean" },
      report: { type: "string" },
      fake: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help === true || positionals.length === 0) return { kind: "help" };

  const [verb, ...files] = positionals;
  if (verb !== "translate") {
    throw new UsageError(`Unknown command "${verb ?? ""}". The only command is "translate".`);
  }
  if (files.length === 0) {
    throw new UsageError("Name at least one subtitle file to translate.");
  }

  const to = values.to;
  if (to === undefined) {
    throw new UsageError("Give a target language with --to, for example --to de.");
  }
  const target = findTargetLanguage(to);
  if (target === undefined) {
    throw new UsageError(
      `"${to}" is not one of the target languages. Use a code such as de, pt-BR or zh-Hans, or the English name.`,
    );
  }

  const lane = values.lane ?? "fast";
  if (!isLane(lane)) {
    throw new UsageError(`--lane must be "fast" or "economy", not "${lane}".`);
  }

  const formality = values.formality ?? "auto";
  if (!FORMALITIES.has(formality)) {
    throw new UsageError(`--formality must be auto, formal or informal, not "${formality}".`);
  }

  const lineHandling = values["line-handling"] ?? "reflow";
  if (lineHandling !== "reflow" && lineHandling !== "keep") {
    throw new UsageError(`--line-handling must be "reflow" or "keep", not "${lineHandling}".`);
  }

  const contextNote = values.context ?? "";
  if (contextNote.length > MAX_CONTEXT_NOTE_LENGTH) {
    throw new UsageError(
      `--context must be at most ${MAX_CONTEXT_NOTE_LENGTH.toString()} characters; it was ${contextNote.length.toString()}.`,
    );
  }

  const effort = values.effort;
  if (effort !== undefined && !isEffort(effort)) {
    throw new UsageError(`--effort must be ${EFFORT_LEVELS.join(", ")}, not "${effort}".`);
  }

  return {
    kind: "translate",
    files,
    target,
    lane,
    formality: formality as Formality,
    contextNote,
    lineHandling: lineHandling === "keep" ? "keep-source-line-count" : "reflow",
    translateLyrics: values["no-lyrics"] !== true,
    fake: values.fake === true,
    model: values.model,
    fallbackModel: values["fallback-model"],
    effort,
    batchSize: positiveInteger(values["batch-size"], "--batch-size"),
    concurrency: positiveInteger(values.concurrency, "--concurrency"),
    outDir: values.out,
    bom: values["no-bom"] !== true,
    reportPath: values.report,
  };
}

function positiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`${flag} must be a whole number of at least 1, not "${value}".`);
  }
  return parsed;
}

export const HELP = `harness translate <files...> --to <language> [options]

Runs the whole translation harness outside AWS: parse, glossary pass, batches,
validation, reassembly and the final verification, then writes each translated
file next to its input as <name>.<language>.<ext> and prints the report, the
price and the model cost.

Required
  --to <language>        Target language code or English name (de, pt-BR, Japanese)

Options
  --lane fast|economy    Delivery lane (default: fast)
  --formality <mode>     auto, formal or informal (default: auto)
  --context <text>       Up to 500 characters of context for the whole upload
  --line-handling <mode> reflow (default) or keep, to keep the source line count
  --no-lyrics            Leave song lyrics in the source language
  --model <id>           Override the configured model id (default: claude-sonnet-5,
                         the product's translation model on both lanes). For
                         measurement runs; it is not a product setting.
  --fallback-model <id>  Model a refused batch is retried on (default: claude-opus-5).
                         Pin it to --model to keep a comparison to one model.
  --effort <level>       low, medium (default), high, xhigh or max
                         Left off entirely for a model that rejects the field; the
                         report prints the effort actually sent
  --batch-size <n>       Cues per request (default: 120)
  --concurrency <n>      Batches in flight per file (default: 12)
  --out <dir>            Write outputs to this directory instead of alongside the inputs
  --no-bom               Write UTF-8 without a byte-order mark
  --report <file>        Also write the JSON report to this file
  --fake                 Use the deterministic fake model; no API key needed
  -h, --help             Show this help

Without --fake the tool reads ANTHROPIC_API_KEY from .env at the repository
root, falling back to the environment, and refuses to start if it is not set. A
value in .env wins, so this checkout always uses its own key.

Examples
  pnpm harness translate film.srt --to de --fake
  pnpm harness translate season/*.srt --to bg --lane economy
`;
