/**
 * `work`, rejected with `expired()` if it outruns `timeoutMs`.
 *
 * **The work is not cancelled, only stopped being waited for.** A handler that
 * outran the bound carries on in the background, so a caller that retries or
 * redelivers can have two runs over one unit of work. Both callers document that.
 *
 * Here rather than in either subpath because `@dunx/infra/queue`'s `jobTimeoutMs`
 * and `@dunx/infra/amqp`'s `handlerTimeoutMs` had written the same race, and a fix
 * to one - the timer that has to be cleared below - would otherwise have to be
 * found in the other by hand. The error is the caller's, since each subpath
 * throws its own type with its own message.
 */
export const withTimeout = async <T>(
  work: () => T | Promise<T>,
  timeoutMs: number,
  expired: () => Error,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(expired()), timeoutMs);
  });

  try {
    return (await Promise.race([work(), expiry])) as T;
  } finally {
    // Otherwise work that finished in time leaves a pending timer, and the
    // process cannot exit until the longest one fires.
    clearTimeout(timer);
  }
};
