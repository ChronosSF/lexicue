import { zipSync } from "fflate";

/**
 * The byte plumbing the mock needs: `localStorage` holds strings, so uploaded
 * files are kept as base64, and downloads are handed to the browser as object
 * URLs, which stand in for the presigned S3 GETs of spec section 7.2.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The zip a multi-file upload downloads as (spec section 2.1). fflate builds it
 * in the browser in a few milliseconds; in the deployed system a Lambda streams
 * the same thing into S3 when the last file finishes.
 */
export function buildZip(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    // Two files with the same name would silently overwrite each other, which
    // is possible when a folder drop carries the same episode twice.
    let name = file.name;
    let attempt = 2;
    while (name in entries) {
      name = suffixName(file.name, attempt);
      attempt += 1;
    }
    entries[name] = file.bytes;
  }
  return zipSync(entries, { level: 6 });
}

function suffixName(name: string, index: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} (${index.toString()})`;
  return `${name.slice(0, dot)} (${index.toString()})${name.slice(dot)}`;
}

/**
 * Object URLs, kept so a poll every second does not leak one per poll. Falls
 * back to a data URL where `createObjectURL` does not exist, which is the case
 * in jsdom.
 */
export type UrlFactory = (bytes: Uint8Array, mime: string) => string;

export class DownloadUrls {
  private readonly urls = new Map<string, string>();
  private readonly factory: UrlFactory;

  /** Tests pass their own factory, because object URLs need a real browser. */
  constructor(factory: UrlFactory = createUrl) {
    this.factory = factory;
  }

  get(key: string, build: () => { bytes: Uint8Array; mime: string }): string {
    const existing = this.urls.get(key);
    if (existing !== undefined) return existing;
    const { bytes, mime } = build();
    const url = this.factory(bytes, mime);
    this.urls.set(key, url);
    return url;
  }

  forget(key: string): void {
    const url = this.urls.get(key);
    if (url === undefined) return;
    revokeUrl(url);
    this.urls.delete(key);
  }

  clear(): void {
    for (const url of this.urls.values()) revokeUrl(url);
    this.urls.clear();
  }
}

/** An object URL where the browser has them, a data URL where it does not. */
export function createUrl(bytes: Uint8Array, mime: string): string {
  if (typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  }
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function revokeUrl(url: string): void {
  if (url.startsWith("blob:") && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}
