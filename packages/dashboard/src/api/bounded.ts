/**
 * Every read the dashboard makes off-process is bounded here. With Redis
 * unreachable, `getJobCounts` waits out the 5 s connection timeout, so opening the
 * dashboard on a broken broker hung the page for as long as the thing you opened
 * it to look at was broken.
 *
 * The fallback is a value rather than a rejection: an unreachable queue still gets
 * a row saying so.
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
