/**
 * Answers whether an error is the one to report, at most once per interval.
 *
 * Time rather than a "connected yet" gate. bullmq emits `Worker`'s `ready` once,
 * from the initial `waitUntilReady` chain, and `rabbitmq-client` re-runs a
 * consumer's setup on its own backoff, so a gate cleared on the first success
 * would latch after one outage and silence every one after it.
 *
 * Here rather than in either subpath because both need it: a broker that is down
 * fails on every retry, and the log that says so measured 21.9M lines in two
 * minutes before this existed. A class, not a closure, because it holds `#last`.
 */
export class ErrorThrottle {
  readonly #intervalMs: number;
  readonly #now: () => number;
  #last = Number.NEGATIVE_INFINITY;

  constructor(intervalMs: number, now: () => number = Date.now) {
    this.#intervalMs = intervalMs;
    this.#now = now;
  }

  /** True at most once per interval, and true again once it has passed. */
  allows(): boolean {
    const at = this.#now();
    if (at - this.#last < this.#intervalMs) return false;
    this.#last = at;
    return true;
  }
}
