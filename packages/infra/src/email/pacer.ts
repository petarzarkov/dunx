/**
 * Spaces the *starts* of outbound sends so a provider's per-second cap is not
 * hit.
 *
 * Not a retry and not a circuit breaker: `ResiliencePolicy` in `@dunx/core` is
 * both of those and deliberately has no rate limiter, and `ThrottleModule` in
 * `@dunx/http` is inbound admission control. This is the third thing, and it is
 * small enough to own: one serialised promise chain and a clock.
 *
 * Only the gate is serialised, not the send, so N messages can be in flight at
 * once while their starts stay `1000 / maxPerSecond` apart. That is what a
 * per-second cap actually constrains, and serialising the sends as well would
 * make the slowest provider response the rate.
 */
export class SendPacer {
  readonly #minIntervalMs: number;
  /** Every waiter joins this chain, which is what orders them. */
  #gate: Promise<void> = Promise.resolve();
  #lastAt = Number.NEGATIVE_INFINITY;

  /** `0` or anything non-finite leaves sends unpaced. */
  constructor(maxPerSecond: number) {
    this.#minIntervalMs =
      Number.isFinite(maxPerSecond) && maxPerSecond > 0
        ? Math.ceil(1000 / maxPerSecond)
        : 0;
  }

  get minIntervalMs(): number {
    return this.#minIntervalMs;
  }

  /**
   * Resolves when this caller may send.
   *
   * `performance.now()` rather than `Date.now()`: it is monotonic, so a clock
   * step backwards cannot park every sender for the length of the step. Nothing
   * inside the link can reject, so the chain cannot poison.
   */
  async wait(): Promise<void> {
    if (this.#minIntervalMs === 0) return;
    this.#gate = this.#gate.then(async () => {
      const waitMs = this.#minIntervalMs - (performance.now() - this.#lastAt);
      if (waitMs > 0) await Bun.sleep(waitMs);
      this.#lastAt = performance.now();
    });
    await this.#gate;
  }
}
