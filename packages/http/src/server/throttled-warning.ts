import type { Logger } from '@dunx/core';

/**
 * A `warn` a caller can trigger at will, written at most once per interval.
 * The next line written carries `suppressed`, the count dropped since the last
 * one, so a flood shows up as one line a second with a number on it.
 *
 * One window for every line, not one per distinct field: a caller picks its own
 * `Origin`, so a window per origin would let it rotate past the limit.
 */
export class ThrottledWarning {
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #now: () => number;
  #last = Number.NEGATIVE_INFINITY;
  #suppressed = 0;

  constructor(
    logger: Logger,
    intervalMs = 1000,
    now: () => number = () => performance.now(),
  ) {
    this.#logger = logger;
    this.#intervalMs = intervalMs;
    this.#now = now;
  }

  warn(message: string, fields: Readonly<Record<string, unknown>>): void {
    const at = this.#now();
    if (at - this.#last < this.#intervalMs) {
      this.#suppressed++;
      return;
    }
    this.#last = at;
    const suppressed = this.#suppressed;
    this.#suppressed = 0;
    this.#logger.warn(
      message,
      suppressed > 0 ? { ...fields, suppressed } : fields,
    );
  }
}
