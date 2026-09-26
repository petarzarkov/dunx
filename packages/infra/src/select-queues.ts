/**
 * The handlers in `discovered` whose queue is `wanted`, or all of them when
 * nothing is. Throws what `fail` builds when that leaves none, with `none` as the
 * message when nothing was asked for, and when a wanted queue has no handler.
 *
 * Here rather than in either subpath because `@dunx/infra/queue` and
 * `@dunx/infra/amqp` had written the same selection, and a process that picks
 * its handlers by queue name must fail the same way on the same typo.
 */
export const selectQueues = <T extends { readonly queue: string }>(
  discovered: readonly T[],
  wanted: readonly string[] | undefined,
  fail: (message: string) => Error,
  none: string,
): readonly T[] => {
  const chosen = wanted
    ? discovered.filter((found) => wanted.includes(found.queue))
    : discovered;

  if (chosen.length === 0) {
    throw fail(
      wanted
        ? `No handler consumes ${wanted.join(', ')}. A process with nothing to ` +
            'do would idle forever, so this is a boot error.'
        : none,
    );
  }

  // A typo in one name of several would otherwise start a process that quietly
  // serves only the queues that were spelled right.
  const missing = (wanted ?? []).filter(
    (queue) => !chosen.some((found) => found.queue === queue),
  );
  if (missing.length > 0) {
    throw fail(
      `No handler consumes ${missing.join(', ')}. Found handlers for ` +
        `${[...new Set(discovered.map((found) => found.queue))].join(', ')}.`,
    );
  }

  return chosen;
};
