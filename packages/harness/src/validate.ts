import {
  describeMarkup,
  isSrtTimingLine,
  markupMultisetsEqual,
  stripMarkup,
} from "@subtitle-translator/subtitles";
import type { HarnessConfig } from "./config.js";
import { looksUntranslated, type TargetLanguage } from "./languages.js";
import { splitTranslatedLines } from "./prompts/render.js";
import { matchLineCount, reflowLines, rewrapWithSourceTags } from "./reflow.js";
import type { LineHandling, ProtocolCue } from "./types.js";

/** A cue the validator refused, with the finding to quote back to the model. */
export interface CueFinding {
  id: number;
  finding: string;
}

export interface BatchValidation {
  /** Cues that passed, possibly after a repair, keyed by id. */
  accepted: Map<number, string[]>;
  /** Cues that must be retried, with the finding to quote back. */
  failures: CueFinding[];
  /** Repairs the harness made, for the report. */
  repairs: string[];
  /** Advisory observations that fail nothing (spec section 4.6). */
  warnings: string[];
}

export interface ValidateOptions {
  sourceCues: readonly ProtocolCue[];
  answers: readonly { i: number; t: string }[];
  target: TargetLanguage;
  config: HarnessConfig;
  lineHandling: LineHandling;
}

/**
 * Every check of spec section 4.6, run over one batch answer. Only failing cues
 * are ever retried, never the whole batch.
 */
export function validateBatch(options: ValidateOptions): BatchValidation {
  const { sourceCues, answers, target, config, lineHandling } = options;
  const accepted = new Map<number, string[]>();
  const failures: CueFinding[] = [];
  const repairs: string[] = [];
  const warnings: string[] = [];

  const requested = new Map(sourceCues.map((cue) => [cue.id, cue]));
  const seen = new Map<number, string>();
  const duplicated = new Set<number>();

  for (const answer of answers) {
    if (!requested.has(answer.i)) {
      warnings.push(`Dropped cue ${answer.i.toString()}, which was not part of this batch.`);
      continue;
    }
    if (seen.has(answer.i)) {
      duplicated.add(answer.i);
      continue;
    }
    seen.set(answer.i, answer.t);
  }

  for (const id of duplicated) {
    failures.push({
      id,
      finding: `cue ${id.toString()} was returned more than once; return it exactly once`,
    });
  }

  for (const cue of sourceCues) {
    if (duplicated.has(cue.id)) continue;
    const answer = seen.get(cue.id);
    if (answer === undefined) {
      failures.push({
        id: cue.id,
        finding: `cue ${cue.id.toString()} was missing from the answer; every requested id must come back`,
      });
      continue;
    }
    const outcome = validateCue(cue, answer, { target, config, lineHandling });
    if (outcome.finding !== null) {
      failures.push({ id: cue.id, finding: outcome.finding });
      continue;
    }
    if (outcome.repair !== null) repairs.push(outcome.repair);
    accepted.set(cue.id, outcome.lines);
  }

  const latinWarning = detectLatinSuspicion(sourceCues, accepted, target);
  if (latinWarning !== null) warnings.push(latinWarning);

  return { accepted, failures, repairs, warnings };
}

interface CueOutcome {
  lines: string[];
  finding: string | null;
  repair: string | null;
}

function validateCue(
  cue: ProtocolCue,
  answer: string,
  options: { target: TargetLanguage; config: HarnessConfig; lineHandling: LineHandling },
): CueOutcome {
  const { target, config, lineHandling } = options;
  const sourceText = cue.lines.join(" ");
  const sourceIsEmpty = stripMarkup(sourceText).trim() === "";

  let lines = splitTranslatedLines(answer);
  let repair: string | null = null;

  // Emptiness: a non-empty source cue must produce a non-empty translation.
  if (!sourceIsEmpty && stripMarkup(lines.join(" ")).trim() === "") {
    return {
      lines,
      finding: `cue ${cue.id.toString()} came back empty; it has dialogue that must be translated`,
      repair: null,
    };
  }
  if (sourceIsEmpty) return { lines: cue.lines, finding: null, repair: null };

  // Leakage: no ids, no commentary, no placeholder markers, no timing lines.
  const leak = findLeakage(lines);
  if (leak !== null) {
    return {
      lines,
      finding: `cue ${cue.id.toString()} ${leak}; return the translated dialogue only`,
      repair: null,
    };
  }

  // Line count: at most two lines unless the source had more, re-flowed at the
  // nearest punctuation rather than failed.
  const maxLines = Math.max(config.maxLinesPerCue, cue.lines.length);
  if (lineHandling === "keep-source-line-count") {
    if (lines.length !== cue.lines.length) {
      lines = matchLineCount(lines, cue.lines.length);
      repair = `cue ${cue.id.toString()} was re-flowed to the source's ${cue.lines.length.toString()} line(s)`;
    }
  } else if (lines.length > maxLines) {
    lines = reflowLines(lines, maxLines);
    repair = `cue ${cue.id.toString()} was re-flowed from ${splitTranslatedLines(answer).length.toString()} lines to ${lines.length.toString()}`;
  }

  // Tags: the multiset must match. If only the placement is wrong, re-wrap.
  if (!markupMultisetsEqual(sourceText, lines.join(" "))) {
    const rewrapped = rewrapWithSourceTags(cue.lines, lines);
    if (rewrapped !== null && markupMultisetsEqual(sourceText, rewrapped.join(" "))) {
      lines = rewrapped;
      repair = `cue ${cue.id.toString()} was re-wrapped in the source's tags`;
    } else {
      return {
        lines,
        finding: `cue ${cue.id.toString()} has the wrong tags: the source has ${describeMarkup(sourceText)} and the translation has ${describeMarkup(lines.join(" "))}`,
        repair: null,
      };
    }
  }

  // Script: for a non-Latin target, mostly-Latin letters means untranslated.
  if (looksUntranslated(stripMarkup(lines.join(" ")), target.script)) {
    return {
      lines,
      finding: `cue ${cue.id.toString()} came back in Latin letters; ${target.name} must be written in its own script`,
      repair: null,
    };
  }

  return { lines, finding: null, repair };
}

const LEAKAGE_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /^\s*\d+\s*\t/u, why: "starts with a cue id" },
  { pattern: /\btranslator'?s note\b/iu, why: "carries a translator's note" },
  { pattern: /\[\[|\]\]|\{\{|\}\}/u, why: "carries a placeholder marker" },
  { pattern: /^\s*(?:note|nb|n\.b\.)\s*:/iu, why: "starts with a note to the reader" },
  { pattern: /"[it]"\s*:/u, why: "carries the JSON keys of the protocol" },
  { pattern: /^\s*<cue\b|^\s*\[cue\s*\d/iu, why: "carries a protocol marker" },
];

function findLeakage(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (isSrtTimingLine(line)) return "carries a timing line";
    for (const { pattern, why } of LEAKAGE_PATTERNS) {
      if (pattern.test(line)) return why;
    }
  }
  return null;
}

/**
 * The lightweight detector of spec section 4.6 for Latin targets: it flags a
 * batch that mostly came back unchanged, but never fails one, because a
 * legitimate translation can share words with its source.
 */
function detectLatinSuspicion(
  sourceCues: readonly ProtocolCue[],
  accepted: ReadonlyMap<number, string[]>,
  target: TargetLanguage,
): string | null {
  if (target.script !== "latin" || accepted.size < 5) return null;
  let unchanged = 0;
  for (const cue of sourceCues) {
    const translated = accepted.get(cue.id);
    if (translated === undefined) continue;
    if (normalise(translated.join(" ")) === normalise(cue.lines.join(" "))) unchanged += 1;
  }
  const ratio = unchanged / accepted.size;
  if (ratio <= 0.5) return null;
  return `${Math.round(ratio * 100).toString()}% of this batch came back identical to the source; check that it was translated into ${target.name}.`;
}

function normalise(text: string): string {
  return stripMarkup(text).replace(/\s+/gu, " ").trim().toLowerCase();
}
