/** The half of a bullmq `Worker` or `QueueEvents`, or a rabbitmq-client
 * `Consumer`, `Publisher` or `Connection`, that {@link closeWithin} needs. */
export interface Closable {
  close(): Promise<unknown>;
}

/**
 * `closable.close()`, waited on for at most `timeoutMs`. Resolves `true` when the
 * bound expired and `false` when the close finished first, so the caller decides
 * whether that is worth a warning and what to do next. A close that rejects
 * rejects here; the close is never escalated, since none of these can be.
 *
 * Shared by the five sites that had written this race by hand. The timer is
 * cleared in a `finally`, because the loser of the race stays pending, and it is
 * unref'd, because a bound on how long to wait is not a reason to stay alive. A
 * race rather than the `AbortSignal.timeout` `ResiliencePolicy` prefers: none of
 * the five closes takes a signal. The argument is in
 * docs/architecture/message-brokers.md, "Bounding a close".
 */
export const closeWithin = async (
  closable: Closable,
  timeoutMs: number,
): Promise<boolean> =>
  (await within(
    closable.close().then(() => false),
    timeoutMs,
  )) ?? true;

/**
 * `work`, waited on for at most `timeoutMs`, resolving `undefined` when the
 * bound expired first. The loser of the race stays pending, so the timer is
 * cleared in a `finally`, and it is unref'd because a bound on how long to wait
 * is no reason to stay alive.
 */
export const within = async <T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
};
