import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSubtitleText } from "@lexicue/subtitles";
import { FakeTranslationModelClient } from "@lexicue/harness";
import { UsageError, parseCommandLine } from "./args.js";
import { loadEnvFile } from "./env-file.js";
import { outputPathFor, readJobs, resolveInputPaths } from "./files.js";
import { main } from "./main.js";
import { MISSING_KEY_MESSAGE, type RunEnvironment } from "./run.js";

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,240",
  "The lighthouse has been dark for a week.",
  "",
  "2",
  "00:00:03,400 --> 00:00:06,120",
  "- And nobody thought to call?",
  "- <i>We called.</i>",
  "",
  "",
].join("\n");

let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "subtitle-cli-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function write(name: string, content: string | Uint8Array): string {
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

interface Capture extends RunEnvironment {
  out: string[];
  err: string[];
}

function capture(env: Record<string, string | undefined> = {}): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    env,
    client: new FakeTranslationModelClient(),
  };
}

describe("parsing the command line", () => {
  it("reads the whole documented flag set", () => {
    const command = parseCommandLine([
      "translate",
      "a.srt",
      "b.srt",
      "--to",
      "pt-BR",
      "--lane",
      "economy",
      "--formality",
      "formal",
      "--context",
      "1970s police drama",
      "--model",
      "claude-haiku-4-5",
      "--fallback-model",
      "claude-haiku-4-5",
      "--effort",
      "low",
      "--batch-size",
      "60",
      "--concurrency",
      "4",
      "--line-handling",
      "keep",
      "--no-lyrics",
      "--out",
      "dist",
      "--no-bom",
      "--report",
      "report.json",
      "--fake",
    ]);
    expect(command).toEqual({
      kind: "translate",
      files: ["a.srt", "b.srt"],
      target: expect.objectContaining({ code: "pt-BR" }) as unknown,
      lane: "economy",
      formality: "formal",
      contextNote: "1970s police drama",
      lineHandling: "keep-source-line-count",
      translateLyrics: false,
      fake: true,
      model: "claude-haiku-4-5",
      fallbackModel: "claude-haiku-4-5",
      effort: "low",
      batchSize: 60,
      concurrency: 4,
      outDir: "dist",
      bom: false,
      reportPath: "report.json",
    });
  });

  it("defaults to the fast lane, automatic formality, re-flow, lyrics and a byte-order mark", () => {
    const command = parseCommandLine(["translate", "a.srt", "--to", "de"]);
    expect(command).toMatchObject({
      lane: "fast",
      formality: "auto",
      lineHandling: "reflow",
      translateLyrics: true,
      bom: true,
      fake: false,
    });
  });

  it("accepts a language by English name as well as by code", () => {
    expect(parseCommandLine(["translate", "a.srt", "--to", "Japanese"])).toMatchObject({
      target: { code: "ja" },
    });
  });

  it("shows the help with no arguments and with --help", () => {
    expect(parseCommandLine([])).toEqual({ kind: "help" });
    expect(parseCommandLine(["--help"])).toEqual({ kind: "help" });
  });

  it.each([
    [["nonsense", "a.srt"], /Unknown command/],
    [["translate"], /at least one subtitle file/],
    [["translate", "a.srt"], /--to/],
    [["translate", "a.srt", "--to", "klingon"], /not one of the target languages/],
    [["translate", "a.srt", "--to", "de", "--lane", "express"], /--lane/],
    [["translate", "a.srt", "--to", "de", "--formality", "brusque"], /--formality/],
    [["translate", "a.srt", "--to", "de", "--line-handling", "sideways"], /--line-handling/],
    [["translate", "a.srt", "--to", "de", "--effort", "colossal"], /--effort/],
    [["translate", "a.srt", "--to", "de", "--batch-size", "0"], /--batch-size/],
    [["translate", "a.srt", "--to", "de", "--concurrency", "two"], /--concurrency/],
  ])("refuses %s", (argv, message) => {
    expect(() => parseCommandLine(argv)).toThrow(UsageError);
    expect(() => parseCommandLine(argv)).toThrow(message);
  });

  it("refuses a context note over 500 characters", () => {
    const argv = ["translate", "a.srt", "--to", "de", "--context", "x".repeat(501)];
    expect(() => parseCommandLine(argv)).toThrow(/at most 500 characters/);
  });
});

describe("output naming", () => {
  it("names the output original-name.de.srt, next to the input", () => {
    expect(outputPathFor(join("season", "s01e01.srt"), "de")).toBe(join("season", "s01e01.de.srt"));
    expect(outputPathFor(join("season", "s01e01.sub"), "pt-BR")).toBe(
      join("season", "s01e01.pt-br.sub"),
    );
  });

  it("writes into another directory when asked", () => {
    expect(outputPathFor(join("season", "s01e01.srt"), "de", "out")).toBe(
      join("out", "s01e01.de.srt"),
    );
  });
});

describe("reading the inputs", () => {
  it("expands a wildcard the shell did not", () => {
    write("a.srt", SRT);
    write("b.srt", SRT);
    const paths = resolveInputPaths([join(directory, "*.srt").replaceAll("\\", "/")]);
    expect(paths).toHaveLength(2);
  });

  it("says which pattern matched nothing", () => {
    expect(() => resolveInputPaths([join(directory, "*.vtt")])).toThrow(/No file matched/);
  });

  it("keeps a rejected file out of the jobs and explains it", () => {
    const good = write("good.srt", SRT);
    const bad = write("movie.sub", new Uint8Array([0x00, 0x00, 0x01, 0xba, 0x44, 0x00]));
    const { jobs, rejected } = readJobs([good, bad]);
    expect(jobs.map((job) => job.fileName)).toEqual(["good.srt"]);
    expect(rejected[0]?.message).toMatch(/Image-based subtitles/);
  });

  it("refuses a .sub that has a VobSub .idx beside it", () => {
    const sub = write("movie.sub", SRT);
    write("movie.idx", "# VobSub index file, v7\n");
    const { jobs, rejected } = readJobs([sub]);
    expect(jobs).toEqual([]);
    expect(rejected[0]?.message).toMatch(/Image-based subtitles/);
  });

  it("gives every job a colon-free id, because it becomes half a custom id", () => {
    const path = write("s01e01 (final cut).srt", SRT);
    const { jobs } = readJobs([path]);
    expect(jobs[0]?.jobId).toMatch(/^\d\d-[A-Za-z0-9_-]+$/);
    expect(jobs[0]?.jobId).not.toContain(":");
  });
});

describe("translating from the command line", () => {
  it("writes the output next to the input and prints the report", async () => {
    const input = write("film.srt", SRT);
    const environment = capture();
    const code = await main(["translate", input, "--to", "de", "--fake"], environment);

    expect(code).toBe(0);
    const outputPath = join(directory, "film.de.srt");
    const written = readFileSync(outputPath, "utf8");
    expect(written.charCodeAt(0)).toBe(0xfeff);

    const output = parseSubtitleText(written);
    const source = parseSubtitleText(SRT);
    expect(output.cues.map((cue) => cue.rawTimingLine)).toEqual(
      source.cues.map((cue) => cue.rawTimingLine),
    );
    expect(output.cues[0]?.lines[0]).toBe("«The lighthouse has been dark for a week.»");

    const printed = environment.out.join("\n");
    expect(printed).toContain("film.srt -> ");
    expect(printed).toContain("2 cues");
    expect(printed).toContain("price $0.10 on the fast lane");
    expect(printed).toContain("model cost $");
    expect(printed).toContain("claude-sonnet-5, effort medium");
  });

  /**
   * `--model` has to carry the model's capabilities with it, not just its name:
   * Haiku 4.5 rejects `output_config.effort`, so the run sends none and the
   * report says so instead of repeating the configured level.
   */
  it("reports no effort for a model that does not accept one", async () => {
    const input = write("film.srt", SRT);
    const environment = capture();
    const code = await main(
      ["translate", input, "--to", "de", "--fake", "--model", "claude-haiku-4-5"],
      environment,
    );
    expect(code).toBe(0);
    expect(environment.out.join("\n")).toContain("claude-haiku-4-5, effort none");
  });

  it("writes without a byte-order mark when asked", async () => {
    const input = write("film.srt", SRT);
    await main(["translate", input, "--to", "de", "--fake", "--no-bom"], capture());
    expect(readFileSync(join(directory, "film.de.srt"), "utf8").charCodeAt(0)).not.toBe(0xfeff);
  });

  it("writes into --out and creates the directory", async () => {
    const input = write("film.srt", SRT);
    const outDir = join(directory, "translated", "de");
    const code = await main(
      ["translate", input, "--to", "de", "--fake", "--out", outDir],
      capture(),
    );
    expect(code).toBe(0);
    expect(readFileSync(join(outDir, "film.de.srt"), "utf8")).toContain("«");
  });

  it("prints the upload summary and the season glossary for several files", async () => {
    write("s01e01.srt", SRT);
    write("s01e02.srt", SRT);
    const environment = capture();
    const code = await main(
      ["translate", join(directory, "*.srt"), "--to", "de", "--fake"],
      environment,
    );
    expect(code).toBe(0);
    const printed = environment.out.join("\n");
    expect(printed).toContain("2 files, 4 cues");
    expect(printed).toContain("season glossary:");
  });

  it("runs the economy lane end to end", async () => {
    const input = write("film.srt", SRT);
    const environment = capture();
    const code = await main(
      ["translate", input, "--to", "de", "--fake", "--lane", "economy"],
      environment,
    );
    expect(code).toBe(0);
    expect(environment.out.join("\n")).toContain("price $0.10 on the economy lane");
    expect(readFileSync(join(directory, "film.de.srt"), "utf8")).toContain("«");
  });

  it("writes the JSON report when asked", async () => {
    const input = write("film.srt", SRT);
    const reportPath = join(directory, "reports", "run.json");
    await main(["translate", input, "--to", "de", "--fake", "--report", reportPath], capture());
    const report: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report).toMatchObject({
      totalCues: 2,
      files: [{ file: "film.srt", promptVersion: expect.stringContaining("@v") as unknown }],
    });
  });

  it("reports a rejected file and exits non-zero, but still translates the rest", async () => {
    const good = write("good.srt", SRT);
    const bad = write("notes.txt", "Just production notes.\n");
    const environment = capture();
    const code = await main(["translate", good, bad, "--to", "de", "--fake"], environment);
    expect(code).toBe(1);
    expect(environment.err.join("\n")).toContain("format was not recognised");
    expect(readFileSync(join(directory, "good.de.srt"), "utf8")).toContain("«");
  });

  it("exits non-zero when nothing could be read", async () => {
    const bad = write("notes.txt", "Just production notes.\n");
    const environment = capture();
    expect(await main(["translate", bad, "--to", "de", "--fake"], environment)).toBe(1);
    expect(environment.err.join("\n")).toContain("Nothing to translate.");
  });

  it("prints the help and exits zero", async () => {
    const environment = capture();
    expect(await main(["--help"], environment)).toBe(0);
    expect(environment.out.join("\n")).toContain("harness translate <files...>");
  });

  it("explains a bad flag and exits with the usage code", async () => {
    const environment = capture();
    expect(await main(["translate", "a.srt", "--to", "klingon"], environment)).toBe(2);
    expect(environment.err.join("\n")).toContain("not one of the target languages");
  });
});

describe("running against the real API", () => {
  it("refuses to start without a key, and says how to run without one", async () => {
    const environment: RunEnvironment = {
      log: () => undefined,
      logError: () => undefined,
      env: {},
    };
    const errors: string[] = [];
    const code = await main(["translate", write("film.srt", SRT), "--to", "de"], {
      ...environment,
      logError: (line) => errors.push(line),
    });
    expect(code).toBe(2);
    expect(errors[0]).toBe(MISSING_KEY_MESSAGE);
    expect(errors[0]).toContain("--fake");
  });

  it("refuses an empty key just as firmly", async () => {
    const errors: string[] = [];
    const code = await main(["translate", write("film.srt", SRT), "--to", "de"], {
      log: () => undefined,
      logError: (line) => errors.push(line),
      env: { ANTHROPIC_API_KEY: "   " },
    });
    expect(code).toBe(2);
    expect(errors[0]).toBe(MISSING_KEY_MESSAGE);
  });
});

describe("the .env file", () => {
  it("puts every key in the file into the environment, in file order", () => {
    const path = write(
      ".env",
      [
        "# the key for this checkout",
        "ANTHROPIC_API_KEY=sk-ant-test",
        'OTHER="two words"',
        "",
      ].join("\n"),
    );
    const env: Record<string, string | undefined> = {};
    expect(loadEnvFile(path, env)).toEqual({
      path,
      found: true,
      loaded: ["ANTHROPIC_API_KEY", "OTHER"],
      overridden: [],
    });
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test", OTHER: "two words" });
  });

  it("replaces a different value already in the environment and reports it", () => {
    const path = write(".env", "ANTHROPIC_API_KEY=sk-ant-file\nSAME=x\n");
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "sk-ant-shell",
      SAME: "x",
      UNTOUCHED: "y",
    };
    expect(loadEnvFile(path, env).overridden).toEqual(["ANTHROPIC_API_KEY"]);
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-file", SAME: "x", UNTOUCHED: "y" });
  });

  it("treats an empty value as set, so an unfilled copy of .env.example refuses to run", async () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-shell" };
    loadEnvFile(write(".env", "ANTHROPIC_API_KEY=\n"), env);
    expect(env["ANTHROPIC_API_KEY"]).toBe("");
    const errors: string[] = [];
    const code = await main(["translate", write("film.srt", SRT), "--to", "de"], {
      log: () => undefined,
      logError: (line) => errors.push(line),
      env,
    });
    expect(code).toBe(2);
    expect(errors[0]).toBe(MISSING_KEY_MESSAGE);
    expect(errors[0]).toContain(".env");
  });

  it("leaves the environment alone when there is no file", () => {
    const path = join(directory, ".env");
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-shell" };
    expect(loadEnvFile(path, env)).toEqual({ path, found: false, loaded: [], overridden: [] });
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-shell" });
  });

  it("fails loudly when the path exists but is not a readable file", () => {
    expect(() => loadEnvFile(directory, {})).toThrow();
  });
});
