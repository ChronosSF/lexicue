import { TARGET_LANGUAGES, findTargetLanguage, type TargetLanguage } from "@lexicue/harness";
import { DEFAULT_RATE_TABLE, meteredOf, priceCents, type RateTable } from "@lexicue/pricing";
import {
  ApiError,
  MAX_FILES_PER_DAY,
  guessSourceLanguage,
  insufficientBalance,
  targetIsSource,
  type Lane,
  type UnusableFile,
} from "@lexicue/shared";
import {
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BYTES,
  SubtitleRejectedError,
  hasImageCompanion,
  type SubtitleDocument,
} from "@lexicue/subtitles";
import { parseSubtitleBytes } from "@lexicue/subtitles/encoding";
import { TOP_UP_AMOUNTS_CENTS } from "@lexicue/pricing";
import { dayStamp, uploadKey, type AccountData, type UploadRecord } from "./records.js";
import type { FileStore } from "./stores.js";

/**
 * Everything that has to be decided before a cent is charged: what each file
 * actually is, what it costs, and whether the job is allowed at all.
 *
 * The browser previews all of this with the same packages, but the answer that
 * counts is this one, because this is the side that takes the money
 * (specification section 6.1). Every refusal here is a sentence a user can act
 * on rather than a code, as section 2.3 requires.
 */

/** One file, parsed, with the price it will be charged. */
export interface IntakeFile {
  upload: UploadRecord;
  document: SubtitleDocument;
  priceCents: number;
}

export interface IntakeResult {
  files: IntakeFile[];
  target: TargetLanguage;
  totalCents: number;
}

/** The size limits of section 3.2, checked on the request rather than the bytes. */
export function assertUploadRequestWithinLimits(files: readonly { byteLength: number }[]): void {
  if (files.length > MAX_FILES_PER_UPLOAD) {
    throw new ApiError({
      code: "limit-exceeded",
      message: `An upload can carry ${MAX_FILES_PER_UPLOAD.toString()} files at a time. Split the rest into a second upload.`,
      limit: "files-per-upload",
    });
  }
  const total = files.reduce((sum, file) => sum + file.byteLength, 0);
  if (total > MAX_UPLOAD_BYTES) {
    throw new ApiError({
      code: "limit-exceeded",
      message: `An upload can carry ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toString()} MB in total. Split the rest into a second upload.`,
      limit: "upload-bytes",
    });
  }
}

export function requireTargetLanguage(code: string): TargetLanguage {
  const target = findTargetLanguage(code);
  if (target === undefined) {
    throw new ApiError({
      code: "bad-request",
      message: "That target language is not on the list.",
    });
  }
  return target;
}

/**
 * Parses and prices every file of an upload, or refuses the whole job.
 *
 * The order of the checks is the order a user can do something about them:
 * files that cannot be read at all, then a target that is already the source
 * language, then the daily limit, then the balance. The balance comes last
 * because a 402 carries the shortfall so the app can offer the right top-up,
 * and there is no point computing it for an upload that was never going to run.
 */
export async function intake(
  data: AccountData,
  files: FileStore,
  request: { uploadIds: readonly string[]; targetLanguage: string; lane: Lane },
  now: number,
  rates: RateTable = DEFAULT_RATE_TABLE,
): Promise<IntakeResult> {
  const target = requireTargetLanguage(request.targetLanguage);

  const uploads = request.uploadIds.map((uploadId) => {
    const upload = data.uploads.find((row) => row.uploadId === uploadId);
    if (upload === undefined) {
      throw new ApiError({
        code: "not-found",
        message:
          "One of these files has expired. Uploaded files are kept for 24 hours; add it again.",
      });
    }
    return upload;
  });

  const names = uploads.map((upload) => upload.fileName);
  const parsed: { upload: UploadRecord; document: SubtitleDocument }[] = [];
  const unusable: UnusableFile[] = [];
  for (const upload of uploads) {
    try {
      if (hasImageCompanion(upload.fileName, names)) {
        throw new SubtitleRejectedError("image-based", upload.fileName);
      }
      const bytes = await files.get(uploadKey(upload.uploadId));
      if (bytes === null) throw new SubtitleRejectedError("empty", upload.fileName);
      parsed.push({
        upload,
        document: parseSubtitleBytes(bytes, { fileName: upload.fileName }),
      });
    } catch (error) {
      unusable.push({
        uploadId: upload.uploadId,
        fileName: upload.fileName,
        reason: error instanceof SubtitleRejectedError ? error.code : "unreadable",
        message:
          error instanceof SubtitleRejectedError
            ? error.message
            : "This file could not be read as a subtitle file.",
      });
    }
  }
  if (unusable.length > 0) {
    throw new ApiError({
      code: "unusable-files",
      message: "Some of these files cannot be translated.",
      files: unusable,
    });
  }

  assertTargetIsNotSource(parsed[0]?.document, target);
  assertDailyLimit(data, parsed.length, now);

  const withPrices = parsed.map((file) => ({
    ...file,
    priceCents: priceCents(meteredOf(file.document), request.lane, rates),
  }));
  const totalCents = withPrices.reduce((sum, file) => sum + file.priceCents, 0);
  if (data.account.balanceCents < totalCents) {
    throw insufficientBalance(totalCents, data.account.balanceCents, TOP_UP_AMOUNTS_CENTS);
  }

  return { files: withPrices, target, totalCents };
}

/**
 * Section 3.3 refuses a target that is already the source, before any charge,
 * but section 4.4 only detects the source language in the glossary pass, which
 * runs after it. So the guess is a stopword count on the first file, and the
 * refusal is on the base language, which is why a Spanish file cannot be
 * translated into either Spanish variant (see apps/web/README.md).
 */
function assertTargetIsNotSource(
  document: SubtitleDocument | undefined,
  target: TargetLanguage,
): void {
  if (document === undefined) return;
  const guess = guessSourceLanguage(document);
  if (!targetIsSource(target.code, guess)) return;
  const name =
    TARGET_LANGUAGES.find((language) => language.code === guess.code)?.name ?? guess.code;
  throw new ApiError({
    code: "target-is-source-language",
    message: `These files already look like ${name ?? ""}. Pick a different target language.`,
    sourceLanguage: name ?? "",
  });
}

function assertDailyLimit(data: AccountData, count: number, now: number): void {
  const filesToday = filesTodayFor(data, now);
  if (filesToday + count <= MAX_FILES_PER_DAY) return;
  throw new ApiError({
    code: "limit-exceeded",
    message: `You have translated ${filesToday.toString()} files today, and the daily limit is ${MAX_FILES_PER_DAY.toString()}. The rest can go through tomorrow.`,
    limit: "files-per-day",
  });
}

/** The counter resets at midnight UTC rather than being swept by a job. */
export function filesTodayFor(data: AccountData, now: number): number {
  return data.account.filesTodayStamp === dayStamp(now) ? data.account.filesToday : 0;
}
