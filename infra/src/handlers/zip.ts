/**
 * The zip builder of specification section 7.2, as a shape.
 *
 * Triggered when the last file of a multi-file upload finishes, it streams the
 * batch's outputs into one zip in S3. `ApiService.zipContents` already decides
 * what goes in and what each entry is called, including the `episode (2).de.srt`
 * rule for a folder drop with two files of the same name, so this function is
 * a stream from S3 through a zip encoder back to S3 and nothing else.
 *
 * **It is a stub**, for the same reason as the poller: there is no bucket to
 * stream from. The local API does the equivalent synchronously with `fflate`,
 * which is where the behaviour is actually exercised today.
 */

export interface ZipEvent {
  userId: string;
  batchId: string;
}

export function handler(_event: ZipEvent): Promise<void> {
  return Promise.reject(
    new Error(
      "The zip builder is not implemented. See infra/src/handlers/zip.ts and infra/README.md.",
    ),
  );
}
