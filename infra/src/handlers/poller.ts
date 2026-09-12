/**
 * The economy-lane poller of specification sections 4.5 and 7.5, as a shape.
 *
 * EventBridge runs it every minute. It lists the `ECONOMY#PENDING` worklist,
 * asks the Message Batches API whether each one has ended, and for an ended
 * batch streams the results keyed by `custom_id`, validates, retries failed
 * cues interactively, reassembles, verifies, stores the outputs and settles
 * every job — which is `collectEconomyBatch` in `packages/harness` followed by
 * the same settling the worker does. A batch that has not ended after 23 hours
 * has its files refunded and re-queued on the fast lane.
 *
 * **It is a stub.** Every piece it needs exists — the harness collects a
 * Message Batch and the core settles a batch — but wiring them without an
 * account, without the table and without a batch to poll would be writing code
 * against a shape nobody has run. The economy lane itself has now been proved
 * against the real API from the command line (root README, 12 September 2026),
 * which is what makes this a transcription job rather than a design one.
 *
 * The thing to know before writing it: `custom_id` must match
 * `^[a-zA-Z0-9_-]{1,64}$`, which specification section 4.5's
 * `{jobId}:{batchIndex}` does not. That cost a submission's worth of glossary
 * passes to find out.
 */

export interface ScheduledEvent {
  time: string;
}

export interface PollResult {
  pending: number;
  settled: number;
  overdue: number;
}

export function handler(_event: ScheduledEvent): Promise<PollResult> {
  return Promise.reject(
    new Error(
      "The economy poller is not implemented. See infra/src/handlers/poller.ts and infra/README.md.",
    ),
  );
}
