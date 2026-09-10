/**
 * Runs `worker` over every item with at most `limit` in flight, preserving the
 * order of the results. The fast lane runs twelve batches of a file at once
 * (spec section 4.4), which is what this is for.
 */
export async function mapWithConcurrency<In, Out>(
  items: readonly In[],
  limit: number,
  worker: (item: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  if (limit < 1) throw new RangeError("concurrency limit must be at least 1");
  const results = new Array<Out>(items.length);
  let next = 0;

  async function run(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await worker(item, index);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

/** Waits for the given number of milliseconds; injectable so tests never sleep. */
export type Wait = (ms: number) => Promise<void>;

export const realWait: Wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
