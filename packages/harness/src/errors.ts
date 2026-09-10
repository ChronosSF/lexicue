/**
 * A transport-level failure from the model API: a 429, a 5xx or a dropped
 * connection. The Anthropic SDK retries these itself; clients that do not are
 * retried by the harness (see `withTransportRetry`).
 */
export class ModelTransportError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "ModelTransportError";
    this.status = options.status;
    this.retryable = options.retryable ?? isRetryableStatus(options.status);
  }
}

/** A Message Batch that has not ended inside the harness's waiting window. */
export class BatchNeverEndedError extends Error {
  readonly batchId: string;
  readonly waitedMs: number;

  constructor(batchId: string, waitedMs: number) {
    super(
      `Message Batch ${batchId} had not ended after ${Math.round(waitedMs / 60_000).toString()} minutes; re-run the affected files on the fast lane and refund them.`,
    );
    this.name = "BatchNeverEndedError";
    this.batchId = batchId;
    this.waitedMs = waitedMs;
  }
}

/** The client cannot run the economy lane. */
export class LaneNotSupportedError extends Error {
  constructor(clientName: string) {
    super(`The model client "${clientName}" does not support the Message Batches API.`);
    this.name = "LaneNotSupportedError";
  }
}

/** Raised when configuration asks for something the harness cannot do. */
export class HarnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessConfigError";
  }
}

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // A connection error, which is worth retrying.
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
