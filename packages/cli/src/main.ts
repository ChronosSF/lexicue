import { HELP, UsageError, parseCommandLine } from "./args.js";
import { runTranslate, type RunEnvironment } from "./run.js";

/** The whole tool, with its input and output injected so it can be tested. */
export async function main(argv: readonly string[], environment: RunEnvironment): Promise<number> {
  try {
    const command = parseCommandLine(argv);
    if (command.kind === "help") {
      environment.log(HELP);
      return 0;
    }
    return await runTranslate(command, environment);
  } catch (error) {
    if (error instanceof UsageError) {
      environment.logError(error.message);
      environment.logError("");
      environment.logError('Run "pnpm harness --help" for the full usage.');
      return 2;
    }
    environment.logError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
