import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AnthropicTranslationClient,
  FakeTranslationModelClient,
  resolveConfig,
  translateUpload,
  type HarnessConfig,
  type TranslationModelClient,
  type TranslationOptions,
} from "@lexicue/harness";
import { encodeSubtitleDocument } from "@lexicue/subtitles/encoding";
import { UsageError, type TranslateCommand } from "./args.js";
import { outputPathFor, readJobs, resolveInputPaths } from "./files.js";
import { formatFileReport, formatUploadSummary } from "./report-lines.js";

export interface RunEnvironment {
  /** Where informational output goes. */
  log: (line: string) => void;
  /** Where problems go. */
  logError: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Overrides the client, so tests never construct the real one. */
  client?: TranslationModelClient;
}

export const MISSING_KEY_MESSAGE =
  "ANTHROPIC_API_KEY is not set. Copy .env.example to .env at the repository root and paste the key there, or export it, or add --fake to run the whole pipeline against the deterministic fake model instead.";

/** Runs `harness translate`. Returns the process exit code. */
export async function runTranslate(
  command: TranslateCommand,
  environment: RunEnvironment,
): Promise<number> {
  const config = configFor(command);
  const client = environment.client ?? clientFor(command, environment);

  const paths = resolveInputPaths(command.files);
  const { jobs, rejected } = readJobs(paths);

  for (const rejection of rejected) {
    environment.logError(`${rejection.path}: ${rejection.message}`);
  }
  if (jobs.length === 0) {
    environment.logError("Nothing to translate.");
    return 1;
  }

  const options: TranslationOptions = {
    target: command.target,
    lane: command.lane,
    formality: command.formality,
    contextNote: command.contextNote,
    lineHandling: command.lineHandling,
    translateLyrics: command.translateLyrics,
  };

  environment.log(
    `Translating ${jobs.length.toString()} file(s) into ${command.target.name} on the ${command.lane} lane with ${client.name === "fake" ? "the fake model" : config.model}.`,
  );

  const upload = await translateUpload({ client, config, options, jobs });

  const outputPaths = new Map<string, string>();
  for (const [index, file] of upload.files.entries()) {
    const inputPath = paths[pathIndexFor(jobs, index, paths)] ?? paths[index] ?? "";
    const outputPath = outputPathFor(inputPath, command.target.code, command.outDir);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, encodeSubtitleDocument(file.document, { bom: command.bom }));
    outputPaths.set(file.report.file, outputPath);
  }

  for (const file of upload.files) {
    environment.log("");
    for (const line of formatFileReport(file.report, outputPaths.get(file.report.file) ?? "")) {
      environment.log(line);
    }
  }

  if (upload.files.length > 1) {
    environment.log("");
    for (const line of formatUploadSummary(upload.report)) environment.log(line);
  }

  if (command.reportPath !== undefined) {
    mkdirSync(dirname(command.reportPath), { recursive: true });
    writeFileSync(command.reportPath, `${JSON.stringify(upload.report, null, 2)}\n`, "utf8");
    environment.log("");
    environment.log(`Report written to ${command.reportPath}`);
  }

  return rejected.length > 0 ? 1 : 0;
}

function configFor(command: TranslateCommand): HarnessConfig {
  return resolveConfig({
    ...(command.model === undefined ? {} : { model: command.model }),
    ...(command.fallbackModel === undefined ? {} : { fallbackModel: command.fallbackModel }),
    ...(command.effort === undefined ? {} : { effort: command.effort }),
    ...(command.batchSize === undefined ? {} : { batchSize: command.batchSize }),
    ...(command.concurrency === undefined ? {} : { concurrency: command.concurrency }),
  });
}

/**
 * The fake client needs nothing; the real one refuses to start without a key
 * rather than failing on the first request.
 */
function clientFor(command: TranslateCommand, environment: RunEnvironment): TranslationModelClient {
  if (command.fake) return new FakeTranslationModelClient();
  const apiKey = environment.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") throw new UsageError(MISSING_KEY_MESSAGE);
  return new AnthropicTranslationClient({ apiKey });
}

/** Maps a translated file back to the path it was read from. */
function pathIndexFor(
  jobs: readonly { fileName: string }[],
  index: number,
  paths: readonly string[],
): number {
  const job = jobs[index];
  if (job === undefined) return index;
  const found = paths.findIndex((path) => path.endsWith(job.fileName));
  return found === -1 ? index : found;
}
