import { EFFORT_LEVELS, capabilitiesFor, isEffort, type Effort } from "@lexicue/harness";

/**
 * `--only` as a list of substrings rather than one. A measurement run wants
 * several named files in a single invocation: run separately, two files do not
 * share the cached system prefix, so the second run's cost measures the cache
 * as well as the thing under test. Commas, trimmed, with empty terms dropped.
 */
export function parseOnlyList(value: string): string[] {
  return value
    .split(",")
    .map((term) => term.trim())
    .filter((term) => term !== "");
}

/** A usable `--effort` level, or the reason it cannot be used. */
export type EffortChoice = { effort: Effort } | { problem: string };

/**
 * Checks an `--effort` level against the harness's capability table rather than
 * against a list of the runner's own: the levels come from the type the harness
 * sends as `output_config.effort`, and a model the table marks as rejecting the
 * field — Haiku 4.5 answers one with an error rather than ignoring it — is
 * refused here, before the glossary passes have been run and paid for.
 */
export function resolveEffort(level: string, model: string): EffortChoice {
  if (!isEffort(level)) {
    return { problem: `--effort must be ${EFFORT_LEVELS.join(", ")}, not "${level}".` };
  }
  if (!capabilitiesFor(model).acceptsEffort) {
    return { problem: `${model} rejects output_config.effort, so --effort cannot be set for it.` };
  }
  return { effort: level };
}
