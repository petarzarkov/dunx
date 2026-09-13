/**
 * Spaces the *starts* of outbound sends so a provider's per-second cap is not
 * hit.
 *
 * Not a retry and not a circuit breaker: `ResiliencePolicy` has no rate limiter
 * and `ThrottleModule` is inbound admission control. This is the third thing.
 *
 * Only the gate is serialised, not the send, so N messages are in flight at once
 * while their starts stay `1000 / maxPerSecond` apart. Serialising the sends too
 * would make the slowest provider response the rate.
 *
 * **Per process, like `ScheduleModule`'s timers.** Two replicas each pace
 * themselves and together send at twice the cap.
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
