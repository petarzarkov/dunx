/**
 * `work`, waited on for at most `timeoutMs`. When the bound expires first the
 * result is `onTimeout()`, and an `onTimeout` that throws rejects instead, which
 * is how a caller turns the bound into its own error type.
 *
 * **The work is not cancelled, only stopped being waited for.** Whatever outran
 * the bound carries on in the background.
 *
 * The loser of the race stays pending, so the timer is cleared in a `finally`,
 * and it is unref'd because a bound on how long to wait is no reason to stay
 * alive. A race rather than `AbortSignal.timeout`, because most of what gets
 * bounded here, a bullmq close or a health probe, takes no signal.
 */
export const within = async <T, F>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => F,
): Promise<T | F> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  }).then(onTimeout);

  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
};
