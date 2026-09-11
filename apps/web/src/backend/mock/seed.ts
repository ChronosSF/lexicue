import { DEFAULT_TRANSLATION_OPTIONS } from "@lexicue/shared";
import type {
  CreateBatchResponse,
  CreateUploadsResponse,
  TopUpResponse,
  UploadTarget,
} from "@lexicue/shared";
import type { Session } from "../types.js";
import type { MockState } from "./state.js";

/**
 * The state a first-time visitor lands in. Nothing here is hand-written data:
 * the demo signs itself in, verifies its email to earn the $2.50, tops up $10
 * three days ago and translates two episodes two hours ago, all through the
 * same public methods a user's clicks go through. The history row, the ledger,
 * the reports and the downloadable files are therefore real output of the real
 * harness, and the wallet arithmetic is the arithmetic under test.
 */

export const DEMO_EMAIL = "demo@example.com";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The two episodes the seeded history was translated from. */
export const SEED_SAMPLES = [
  "season/skerry-point-s01e01.srt",
  "season/skerry-point-s01e02.srt",
] as const;

/** What the seed needs from the backend: its own public API, and its clock. */
export interface SeedTarget {
  setClockOffset: (ms: number) => void;
  signIn: (input: { email: string }) => Promise<Session>;
  verifyEmail: () => Promise<Session>;
  createTopUp: (request: { amountCents: number }) => Promise<TopUpResponse>;
  completeCheckout: (sessionId: string) => Promise<void>;
  createUploads: (request: {
    files: { fileName: string; byteLength: number }[];
  }) => Promise<CreateUploadsResponse>;
  putUpload: (target: UploadTarget, bytes: Uint8Array) => Promise<void>;
  createBatch: (request: {
    uploadIds: string[];
    targetLanguage: string;
    lane: "fast" | "economy";
    options: typeof DEFAULT_TRANSLATION_OPTIONS;
  }) => Promise<CreateBatchResponse>;
}

export interface SeedDependencies {
  now: () => number;
  loadSample: (path: string) => Promise<Uint8Array>;
}

export async function seedDemoState(
  backend: SeedTarget,
  state: MockState,
  dependencies: SeedDependencies,
): Promise<void> {
  try {
    backend.setClockOffset(-3 * DAY_MS);
    await backend.signIn({ email: DEMO_EMAIL });
    await backend.verifyEmail();
    const checkout = await backend.createTopUp({ amountCents: 1000 });
    await backend.completeCheckout(checkout.sessionId);

    // A finished upload in the history, translated two hours ago so its files
    // are still inside the 24 hours the product keeps them for.
    backend.setClockOffset(-2 * HOUR_MS);
    const files = await Promise.all(
      SEED_SAMPLES.map(async (path) => ({
        fileName: path.split("/").pop() ?? path,
        bytes: await dependencies.loadSample(path),
      })),
    );
    const uploads = await backend.createUploads({
      files: files.map((file) => ({ fileName: file.fileName, byteLength: file.bytes.length })),
    });
    await Promise.all(
      uploads.uploads.map((target, index) =>
        backend.putUpload(target, files[index]?.bytes ?? new Uint8Array()),
      ),
    );
    await backend.createBatch({
      uploadIds: uploads.uploads.map((target) => target.uploadId),
      targetLanguage: "de",
      lane: "economy",
      options: { ...DEFAULT_TRANSLATION_OPTIONS, contextNote: "Coastal drama, keep place names." },
    });
  } catch {
    // Without the sample files — offline, or a test that did not stub them —
    // the demo still starts signed in with its balance; only the history row
    // is missing.
    if (state.user === null) {
      backend.setClockOffset(-3 * DAY_MS);
      await backend.signIn({ email: DEMO_EMAIL });
      await backend.verifyEmail();
    }
  } finally {
    backend.setClockOffset(0);
  }
}
