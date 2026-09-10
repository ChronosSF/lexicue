import { priceCents, type Lane } from "@subtitle-translator/pricing";
import {
  MAX_FILE_BYTES,
  REJECTION_MESSAGES,
  SubtitleRejectedError,
  hasImageCompanion,
  inspectBytes,
  type SubtitleDocument,
} from "@subtitle-translator/subtitles";
import { parseSubtitleBytesInBrowser } from "@subtitle-translator/subtitles/browser";
import { unzipSync } from "fflate";

/**
 * The upload screen's half of spec section 2.1: the browser parses every file
 * the moment it arrives, with the same package the server uses, and shows what
 * it understood and what it will cost before anything is charged. A file it
 * cannot use is explained in its own row and can be removed without discarding
 * the rest.
 */

const SUBTITLE_EXTENSIONS = [".srt", ".sub"];

export interface RawFile {
  name: string;
  bytes: Uint8Array;
}

export interface FilePreview {
  format: SubtitleDocument["format"];
  encoding: string;
  bom: boolean;
  cueCount: number;
  dialogueChars: number;
  /** Where the last cue ends, which is what a subtitle file's length means. */
  runningTimeMs: number;
  priceCents: Record<Lane, number>;
  warnings: string[];
}

export interface LocalFile {
  id: string;
  fileName: string;
  bytes: Uint8Array;
  byteLength: number;
  /** Null when the file cannot be used; `problem` then says why. */
  preview: FilePreview | null;
  /** The exact sentence from `packages/subtitles`, or null. */
  problem: string | null;
}

export interface IntakeResult {
  files: LocalFile[];
  /** Things inside a zip or a folder that are not subtitle files at all. */
  ignored: string[];
}

let counter = 0;

/**
 * Turns whatever was dropped into rows for the table: zips are unpacked in the
 * browser, non-subtitle entries are noted rather than shown, and every
 * remaining file is parsed and priced.
 */
export function intake(raw: RawFile[], existingNames: readonly string[] = []): IntakeResult {
  const expanded: RawFile[] = [];
  const ignored: string[] = [];

  for (const file of raw) {
    if (isZip(file)) {
      const unpacked = unpackZip(file);
      expanded.push(...unpacked.files);
      ignored.push(...unpacked.ignored);
      continue;
    }
    if (!isSubtitleName(file.name)) {
      ignored.push(file.name);
      continue;
    }
    expanded.push(file);
  }

  // A `.sub` next to a `.idx` is a VobSub pair: pictures of text. The sibling
  // list includes everything the table has already seen, ignored entries and
  // all, because the two halves often arrive in separate drops.
  const siblings = [...existingNames, ...raw.map((file) => file.name)];

  return {
    files: expanded.map((file) => describe(file, siblings)),
    ignored,
  };
}

function describe(file: RawFile, siblings: readonly string[]): LocalFile {
  counter += 1;
  const base = {
    id: `local-${counter.toString()}`,
    fileName: file.name,
    bytes: file.bytes,
    byteLength: file.bytes.length,
  };

  const rejection = inspectBytes(file.bytes, file.name);
  if (rejection !== null) {
    return { ...base, preview: null, problem: REJECTION_MESSAGES[rejection] };
  }
  if (hasImageCompanion(file.name, siblings)) {
    return { ...base, preview: null, problem: REJECTION_MESSAGES["image-based"] };
  }

  try {
    const document = parseSubtitleBytesInBrowser(file.bytes, { fileName: file.name });
    return { ...base, preview: previewOf(document), problem: null };
  } catch (error) {
    return {
      ...base,
      preview: null,
      problem:
        error instanceof SubtitleRejectedError
          ? error.message
          : "This file could not be read as a subtitle file.",
    };
  }
}

export function previewOf(document: SubtitleDocument): FilePreview {
  return {
    format: document.format,
    encoding: document.encoding,
    bom: document.bom,
    cueCount: document.cues.length,
    dialogueChars: document.dialogueChars,
    runningTimeMs: document.cues.reduce((longest, cue) => Math.max(longest, cue.endMs), 0),
    priceCents: {
      fast: priceCents(document.dialogueChars, "fast"),
      economy: priceCents(document.dialogueChars, "economy"),
    },
    warnings: document.warnings,
  };
}

/** What the upload costs on one lane, counting only the files it can use. */
export function totalCents(files: readonly LocalFile[], lane: Lane): number {
  return files.reduce((sum, file) => sum + (file.preview?.priceCents[lane] ?? 0), 0);
}

export function usableFiles(files: readonly LocalFile[]): LocalFile[] {
  return files.filter((file) => file.preview !== null);
}

function isZip(file: RawFile): boolean {
  if (file.name.toLowerCase().endsWith(".zip")) return true;
  const [a, b] = file.bytes;
  return a === 0x50 && b === 0x4b;
}

function isSubtitleName(name: string): boolean {
  const lower = name.toLowerCase();
  return SUBTITLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function unpackZip(file: RawFile): { files: RawFile[]; ignored: string[] } {
  const files: RawFile[] = [];
  const ignored: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(file.bytes);
  } catch {
    return { files: [], ignored: [file.name] };
  }

  for (const [path, bytes] of Object.entries(entries)) {
    const name = path.split("/").pop() ?? path;
    // Directory entries, resource forks and everything that is not a subtitle.
    if (name === "" || name.startsWith(".") || path.startsWith("__MACOSX/")) continue;
    if (!isSubtitleName(name)) {
      ignored.push(name);
      continue;
    }
    files.push({ name, bytes });
  }
  return { files, ignored };
}

/** Reads a browser `File`, refusing anything over the 5 MB cap before decoding. */
export async function readFile(file: File): Promise<RawFile> {
  if (file.size > MAX_FILE_BYTES) {
    // The bytes are not read at all: the presigned policy would refuse them
    // anyway, and reading 200 MB to say so would freeze the tab.
    return { name: file.name, bytes: new Uint8Array(MAX_FILE_BYTES + 1) };
  }
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/**
 * Everything dropped, folders included. `webkitGetAsEntry` is how a browser
 * exposes a dropped directory; where it is missing, the flat file list is used.
 */
export async function readDrop(transfer: DataTransfer): Promise<RawFile[]> {
  const entries = [...transfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null));

  if (entries.every((entry) => entry === null)) {
    return Promise.all([...transfer.files].map(readFile));
  }

  const collected: RawFile[] = [];
  for (const entry of entries) {
    if (entry === null) continue;
    collected.push(...(await readEntry(entry)));
  }
  return collected;
}

async function readEntry(entry: FileSystemEntry): Promise<RawFile[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    return [await readFile(file)];
  }
  if (!entry.isDirectory) return [];

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // `readEntries` returns at most a hundred at a time and signals the end with
  // an empty batch, so a season folder needs the loop.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    children.push(...batch);
  }

  const files: RawFile[] = [];
  for (const child of children) files.push(...(await readEntry(child)));
  return files;
}
