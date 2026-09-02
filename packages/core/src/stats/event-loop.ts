import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { OnInit, OnShutdown } from '../di/lifecycle.js';
import { snapshotOf, type HistogramSnapshot } from './histogram.js';

/**
 * A class rather than an interface because a consumer injects it, which is what
 * Rule 3 requires of anything reaching an injection site.
 */
export class EventLoopLagOptions {
  /** Sampling interval in milliseconds. @default 20 */
  readonly resolution: number;

  constructor(init: { readonly resolution?: number } = {}) {
    this.resolution = init.resolution ?? 20;
  }
}

/**
 * Event-loop delay, on `monitorEventLoopDelay` - which Bun implements natively
 * and which reported 279-299 ms for a 300 ms block across 20 trials.
 *
 * Enabled in `onInit` rather than at read time. A block in the same event-loop
 * turn as `enable()` is not sampled, so a monitor first enabled by a scrape
 * reports 1.6-7.9 ms for a 300 ms stall. It does not hold the loop open, so a
 * process still exits with one running.
 *
 * A `setTimeout`-delta implementation was measured instead and is worse: on an
 * idle loop it reported 0.3-5.5 ms of lag that is timer coalescing.
 * `performance.eventLoopUtilization` and `performance.nodeTiming` are both
 * `undefined` under Bun.
 */
export class EventLoopLag implements OnInit, OnShutdown {
  readonly #histogram: IntervalHistogram;
  #enabled = false;

  constructor(options: EventLoopLagOptions = new EventLoopLagOptions()) {
    this.#histogram = monitorEventLoopDelay({
      resolution: options.resolution,
    });
  }

  onInit(): void {
    if (this.#enabled) return;
    this.#histogram.enable();
    this.#enabled = true;
  }

  onShutdown(): void {
    if (!this.#enabled) return;
    this.#histogram.disable();
    this.#enabled = false;
  }

  reset(): void {
    this.#histogram.reset();
  }

  /** Nanoseconds, and every field but `count` absent until something is sampled. */
  snapshot(): HistogramSnapshot {
    return snapshotOf(this.#histogram);
  }
}
