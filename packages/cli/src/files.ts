import { existsSync, globSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { SubtitleRejectedError, assertNoImageCompanion } from "@lexicue/subtitles";
import { parseSubtitleBytes } from "@lexicue/subtitles/encoding";
import type { TranslationJob } from "@lexicue/harness";

/**
 * Expands the arguments into real paths. Shells expand `season/*.srt`
 * themselves; PowerShell does not, so a pattern that did not match a file is
 * expanded here too.
 */
export function resolveInputPaths(patterns: readonly string[]): string[] {
  const paths: string[] = [];
  for (const pattern of patterns) {
    if (existsSync(pattern)) {
      paths.push(resolve(pattern));
      continue;
    }
    const matches = globSync(pattern.replaceAll("\\", "/"))
      .map((match) => resolve(match))
      .sort();
    if (matches.length === 0) {
      throw new Error(`No file matched "${pattern}".`);
    }
    paths.push(...matches);
  }
  return [...new Set(paths)];
}

/** A file that could not be read, with the sentence to show for it. */
export interface RejectedFile {
  path: string;
  message: string;
}

/** Reads and parses every input, keeping the rejections rather than throwing. */
export function readJobs(paths: readonly string[]): {
  jobs: TranslationJob[];
  rejected: RejectedFile[];
} {
  const jobs: TranslationJob[] = [];
  const rejected: RejectedFile[] = [];
  const siblingsByDirectory = new Map<string, string[]>();

  for (const path of paths) {
    const directory = dirname(path);
    if (!siblingsByDirectory.has(directory)) {
      siblingsByDirectory.set(
        directory,
        globSync(join(directory, "*").replaceAll("\\", "/")).map((entry) => basename(entry)),
      );
    }
    const fileName = basename(path);
    try {
      assertNoImageCompanion(fileName, siblingsByDirectory.get(directory) ?? []);
      const document = parseSubtitleBytes(new Uint8Array(readFileSync(path)), { fileName });
      jobs.push({ jobId: jobIdFor(path, jobs.length), fileName, document });
    } catch (error) {
      rejected.push({
        path,
        message:
          error instanceof SubtitleRejectedError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }

  return { jobs, rejected };
}

/**
 * The output name of spec section 2.1: `original-name.de.srt`. The language tag
 * is lower-cased in file names, where case is not always preserved.
 */
export function outputPathFor(inputPath: string, languageCode: string, outDir?: string): string {
  const extension = extname(inputPath);
  const stem = basename(inputPath, extension);
  const directory = outDir ?? dirname(inputPath);
  return join(directory, `${stem}.${languageCode.toLowerCase()}${extension}`);
}

/**
 * A stable, readable job id. It becomes the `{jobId}` half of every Message
 * Batch custom id, so it must contain no colon.
 */
export function jobIdFor(path: string, index: number): string {
  const stem = basename(path, extname(path)).replace(/[^A-Za-z0-9_-]+/g, "-");
  return `${index.toString().padStart(2, "0")}-${stem}`;
}
