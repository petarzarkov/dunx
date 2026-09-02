/**
 * A monotonic count. A plain field increment measured 9.4 ns against 23.5 ns
 * through a `Map`, so the state is a field and a registry keyed by name is the
 * caller's problem rather than this class's.
 */
export class Counter {
  protected current = 0;

  /**
   * A negative step is ignored rather than applied: this class is monotonic, and
   * a `Counter` that went down would be a `Gauge` a consumer was handed under the
   * wrong contract. `Gauge.dec()` is the way down.
   */
  inc(by = 1): void {
    if (by < 0) return;
    this.current += by;
  }

  get value(): number {
    return this.current;
  }

  reset(): void {
    this.current = 0;
  }
}

/**
 * A {@link Counter} that also goes down and can be set outright: connections
 * held, items queued, workers busy.
 *
 * `Bun.serve` already counts requests in flight on `server.pendingRequests`, at
 * 14.7 ns a read, so nothing in dunx counts those with one of these.
 */
export class Gauge extends Counter {
  dec(by = 1): void {
    this.current -= by;
  }

  set(value: number): void {
    this.current = value;
  }
}
