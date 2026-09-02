import { createHistogram, type RecordableHistogram } from 'node:perf_hooks';

/**
 * Nanoseconds. Every field but `count` is absent when `count` is 0: an empty
 * native histogram reports `min` as 9223372036854776000, `mean` as `NaN` and
 * `max` as 0, and serialising those would put three lies in a payload.
 */
export interface HistogramSnapshot {
  readonly count: number;
  readonly min?: number;
  readonly max?: number;
  readonly p50?: number;
  readonly p90?: number;
  readonly p95?: number;
  readonly p99?: number;
  readonly p999?: number;
}

/** The smallest value the native histogram accepts. */
const FLOOR = 1;

/** The half of a native histogram both {@link Durations} and `EventLoopLag` read. */
interface Percentiles {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  percentile(percent: number): number;
}

/**
 * One reader for both, since an interval histogram and a recording one answer
 * the same four members. `count === 0` returns `count` alone rather than the
 * sentinels an empty native histogram reports.
 */
export const snapshotOf = (h: Percentiles): HistogramSnapshot =>
  h.count === 0
    ? { count: 0 }
    : {
        count: h.count,
        min: h.min,
        max: h.max,
        p50: h.percentile(50),
        p90: h.percentile(90),
        p95: h.percentile(95),
        p99: h.percentile(99),
        p999: h.percentile(99.9),
      };

/**
 * A recording histogram, on `node:perf_hooks.createHistogram` - a HDR histogram
 * compiled into the runtime rather than a JavaScript one. `record` is 11.1 ns at
 * a percentile error under 0.1%.
 *
 * Four native edges are closed here, each measured on Bun 1.4.0:
 *
 * - `record(0)` and `record(-1)` throw `ERR_OUT_OF_RANGE`, so anything under 1
 *   clamps.
 * - An empty histogram reports sentinels, so `snapshot()` omits every field but
 *   `count` until something is recorded.
 * - `percentiles` is a `Map` of `bigint` that `JSON.stringify` turns into `{}`
 *   with no error. `percentile(n)` returns a `number` and is what is read.
 * - `mean` costs 42.2 us against `percentile()`'s 3.9 us, so it is not offered.
 *
 * No options: explicit bounds cost 8-19x the memory and record slower.
 */
export class Durations {
  readonly #histogram: RecordableHistogram = createHistogram();

  /** Values below 1 ns clamp to 1, which the native histogram rejects outright. */
  record(nanoseconds: number): void {
    this.#histogram.record(
      nanoseconds >= FLOOR ? Math.round(nanoseconds) : FLOOR,
    );
  }

  reset(): void {
    this.#histogram.reset();
  }

  get count(): number {
    return this.#histogram.count;
  }

  snapshot(): HistogramSnapshot {
    return snapshotOf(this.#histogram);
  }
}
