import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyChanges,
  emptyAccount,
  type AccountChanges,
  type AccountData,
  type FileStore,
  type MetadataStore,
} from "@lexicue/core";

/**
 * The core's two stores, on disk, for one developer on one machine.
 *
 * This is the whole of what `packages/dev-api` knows about storage, and it is
 * the shape a DynamoDB store and an S3 store take in Phase 2: the same two
 * interfaces, a different backing. Metadata is one JSON file and the file bytes
 * are ordinary files, both under `.local/`, which is git-ignored and thrown away
 * by the demo reset.
 *
 * A whole-file write on every commit is fine here and would be absurd in
 * DynamoDB, which is exactly why `commit` takes the rows that changed rather
 * than a snapshot: the interface is the one the deployed store wants, and this
 * implementation simply ignores the opportunity.
 */

/** Bumped whenever the stored shape changes; older state is discarded. */
export const STATE_VERSION = 2;

interface StoredFile {
  version: number;
  data: AccountData;
}

/** The repository's `.local/dev-api`, which is git-ignored. */
export function defaultStateDir(): string {
  return fileURLToPath(new URL("../../../.local/dev-api", import.meta.url));
}

/** What `api.store.current()` hands back: the rows, plus the wallet up front. */
export interface DevSnapshot extends AccountData {
  balanceCents: number;
  freeCents: number;
}

export class DevStore {
  readonly dir: string;
  readonly metadata: MetadataStore;
  readonly files: FileStore;
  private data: AccountData;

  constructor(dir: string = defaultStateDir()) {
    this.dir = dir;
    this.data = this.read();

    this.metadata = {
      load: () => Promise.resolve(structuredClone(this.data)),
      commit: (changes: AccountChanges) => {
        applyChanges(this.data, changes);
        this.save();
        return Promise.resolve();
      },
      clear: () => {
        this.data = emptyAccount();
        rmSync(join(this.dir, "state.json"), { force: true });
        this.save();
        return Promise.resolve();
      },
    };

    this.files = {
      put: (key, bytes) => {
        const path = this.pathFor(key);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        return Promise.resolve();
      },
      get: (key) => {
        try {
          return Promise.resolve(new Uint8Array(readFileSync(this.pathFor(key))));
        } catch {
          return Promise.resolve(null);
        }
      },
      remove: (key) => {
        rmSync(this.pathFor(key), { force: true });
        return Promise.resolve();
      },
      clear: () => {
        for (const folder of ["uploads", "outputs"]) {
          rmSync(join(this.dir, folder), { recursive: true, force: true });
        }
        return Promise.resolve();
      },
    };
  }

  /**
   * Everything stored, for the tests and for `pnpm dev`'s own diagnostics. The
   * wallet fields are lifted to the top so a caller can read a balance without
   * knowing which row it sits on.
   */
  current(): DevSnapshot {
    return {
      ...this.data,
      balanceCents: this.data.account.balanceCents,
      freeCents: this.data.account.freeCents,
    };
  }

  /** The demo reset: every uploaded and translated file, and the wallet. */
  reset(): void {
    rmSync(this.dir, { recursive: true, force: true });
    this.data = emptyAccount();
    this.save();
  }

  private pathFor(key: string): string {
    // Keys are the `uploads/{id}` and `outputs/{id}` of spec section 7.2, and
    // the core is the only thing that makes them, so they need no escaping.
    return join(this.dir, key);
  }

  private read(): AccountData {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8"));
      if (typeof parsed !== "object" || parsed === null) return emptyAccount();
      const stored = parsed as StoredFile;
      // State written by an older build is thrown away rather than migrated; a
      // wrong balance would be worse than a fresh start.
      return stored.version === STATE_VERSION ? stored.data : emptyAccount();
    } catch {
      return emptyAccount();
    }
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    const stored: StoredFile = { version: STATE_VERSION, data: this.data };
    writeFileSync(join(this.dir, "state.json"), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  }
}
