/**
 * Every read the dashboard makes off-process is bounded, and this is the one
 * implementation of that.
 *
 * The failure it exists for is specific and was measured: with Redis unreachable,
 * a queue's `getJobCounts` waits out the connection timeout - 5 s by default in
 * `@dunx/infra/queue` - so opening the dashboard on a broken broker hung the page
 * for exactly as long as the thing you opened it to look at was broken. A
 * dependency being down must cost one panel, not the page.
 *
 * The fallback is a **value**, not a rejection: a queue that could not be reached
 * still gets a row saying so, which is the whole point of looking.
 */
export const bounded = async <T>(
  work: () => Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    // Unconditional: the winner is usually the work, and leaving the timer armed
    // would hold a handle per poll - which on a 5 s interval is a leak.
    if (timer !== undefined) clearTimeout(timer);
  }
};
