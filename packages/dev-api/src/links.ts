import { createHmac, timingSafeEqual } from "node:crypto";
import type { DownloadSigner } from "@lexicue/core";

/**
 * How a finished file becomes a URL here.
 *
 * In the deployed system this is a presigned S3 GET valid for fifteen minutes
 * (spec section 7.2). Locally it is the same idea with a smaller signature, so
 * the browser follows a plain link with no `Authorization` header exactly as it
 * will against S3, and none of the client code changes when S3 arrives.
 */

/** How long a download link lives, as spec section 7.2 sets it for S3. */
export const DOWNLOAD_TTL_MS = 15 * 60 * 1000;

export class DownloadLinks implements DownloadSigner {
  private readonly secret: Buffer;

  constructor(secret: Buffer) {
    this.secret = secret;
  }

  fileUrl(jobId: string, now: number): string {
    return this.sign(`/api/dev/files/${jobId}`, jobId, now);
  }

  zipUrl(batchId: string, now: number): string {
    return this.sign(`/api/dev/files/${batchId}/zip`, `${batchId}:zip`, now);
  }

  /** `?expires=…&signature=…`, a presigned GET in miniature. */
  sign(path: string, id: string, now: number): string {
    const expires = now + DOWNLOAD_TTL_MS;
    return `${path}?expires=${expires.toString()}&signature=${this.mac(id, expires)}`;
  }

  verify(id: string, expires: string | null, signature: string | null, now: number): boolean {
    if (expires === null || signature === null) return false;
    const expiry = Number(expires);
    if (!Number.isFinite(expiry) || expiry < now) return false;
    const expected = Buffer.from(this.mac(id, expiry), "utf8");
    const given = Buffer.from(signature, "utf8");
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private mac(id: string, expires: number): string {
    return createHmac("sha256", this.secret).update(`${id}:${expires.toString()}`).digest("hex");
  }
}
