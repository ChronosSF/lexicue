import { formatCents } from "@subtitle-translator/pricing";

/** The small formatting decisions the whole interface shares. */

/**
 * Money the way the specification writes it in prose: a whole amount is "$5",
 * anything else keeps its cents. Prices in tables always keep both digits, so
 * columns line up; this is for sentences and buttons.
 */
export function formatDollars(cents: number): string {
  const written = formatCents(cents);
  return written.endsWith(".00") ? written.slice(0, -3) : written;
}

const FORMAT_NAMES: Record<string, string> = {
  srt: "SubRip",
  microdvd: "MicroDVD",
  subviewer: "SubViewer",
};

export function formatName(format: string): string {
  return FORMAT_NAMES[format] ?? format;
}

/** "1:52:07" for a film, "22:14" for an episode. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours.toString()}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Dates in the history: "10 September, 14:05". */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 22 hours" for a file that is about to be deleted. */
export function formatRelativeFuture(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "shortly";
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours >= 2) return `in ${hours.toString()} hours`;
  const minutes = Math.max(1, Math.round(ms / (60 * 1000)));
  return `in ${minutes.toString()} minute${minutes === 1 ? "" : "s"}`;
}

/** Joins a list the way a sentence does: "a, b and c". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}
