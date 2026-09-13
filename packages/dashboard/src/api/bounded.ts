/**
 * Every read the dashboard makes off-process is bounded here. With Redis
 * unreachable, `getJobCounts` waits out the 5 s connection timeout, so opening the
 * dashboard on a broken broker hung the page for as long as the thing you opened
 * it to look at was broken.
 *
 * The fallback is a value rather than a rejection: an unreachable queue still gets
 * a row saying so.
 *
 * Not shared with `@dunx/infra`'s `closeWithin`, which bounds the same way. That
 * one bounds a close during teardown and answers whether the bound expired; this
 * bounds a read during a request and answers with a value a panel can render, so
 * neither is the other with an argument added. Sharing the four lines under them
 * would mean either `@dunx/dashboard` depending on `@dunx/infra`, which it does
 * not and must not, or a timeout primitive on `@dunx/core`'s public surface.
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
