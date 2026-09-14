import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { TranslationJob } from "@lexicue/harness";
import { parseSubtitleBytes } from "@lexicue/subtitles/encoding";

/** Where the corpus lives, relative to this file. */
export const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");

export const CorpusFileSchema = z.object({
  path: z.string(),
  title: z.string(),
  genre: z.enum(["comedy", "drama", "documentary"]),
  sourceLanguage: z.string(),
  format: z.enum(["srt", "microdvd", "subviewer"]),
  covers: z.array(z.string()),
  /** What the parser finds in this file, and what it costs on each lane today. */
  cues: z.int().positive(),
  dialogueChars: z.int().positive(),
  /**
   * The price of spec section 6.1 under the default rate table, recorded here
   * so a change to the price function, the rate table or the parser has to
   * change this file too. Nothing may move these numbers by accident.
   */
  expectedPriceCents: z.object({ fast: z.int().positive(), economy: z.int().positive() }),
  hearingImpaired: z.boolean().optional(),
  sameDialogueAs: z.string().optional(),
  season: z.string().optional(),
  episode: z.number().int().optional(),
});
export type CorpusFile = z.infer<typeof CorpusFileSchema>;

export const ManifestSchema = z.object({
  note: z.string(),
  files: z.array(CorpusFileSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** Reads and validates the corpus manifest. */
export function loadManifest(root = CORPUS_ROOT): Manifest {
  const raw: unknown = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  return ManifestSchema.parse(raw);
}

/** A corpus entry with its parsed document. */
export interface CorpusEntry {
  file: CorpusFile;
  job: TranslationJob;
}

/** Reads every corpus file listed in the manifest, in manifest order. */
export function loadCorpus(root = CORPUS_ROOT): CorpusEntry[] {
  return loadManifest(root).files.map((file, index) => {
    const bytes = new Uint8Array(readFileSync(join(root, file.path)));
    const fileName = file.path.split("/").pop() ?? file.path;
    return {
      file,
      job: {
        jobId: `${index.toString().padStart(2, "0")}-${fileName.replace(/[^A-Za-z0-9_-]+/g, "-")}`,
        fileName,
        document: parseSubtitleBytes(bytes, { fileName }),
      },
    };
  });
}

/** The corpus entries that belong to one season, in episode order. */
export function seasonEntries(entries: readonly CorpusEntry[], season: string): CorpusEntry[] {
  return entries
    .filter((entry) => entry.file.season === season)
    .sort((left, right) => (left.file.episode ?? 0) - (right.file.episode ?? 0));
}

/** The corpus entries that are not part of a season. */
export function standaloneEntries(entries: readonly CorpusEntry[]): CorpusEntry[] {
  return entries.filter((entry) => entry.file.season === undefined);
}

/**
 * The eight targets of spec section 10.4, chosen to span the difficulty range
 * from a close Germanic language to three different non-Latin scripts.
 */
export const EVAL_TARGETS = ["de", "es", "fr", "pl", "bg", "el", "ja", "hi"] as const;
