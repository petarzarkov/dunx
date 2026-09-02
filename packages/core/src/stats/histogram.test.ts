import { describe, expect, it } from 'bun:test';
import { Durations } from './histogram.js';

/**
 * The four native edges this class exists to close, each reproduced on Bun 1.4.0
 * before being wrapped. A Bun change breaks this file and nothing else.
 */
describe('Durations', () => {
  it('reports count alone while empty, never the native sentinels', () => {
    // The raw histogram answers min 9223372036854776000, mean NaN and max 0.
    expect(new Durations().snapshot()).toEqual({ count: 0 });
  });

  it('clamps a sub-nanosecond observation instead of throwing', () => {
    const durations = new Durations();
    // record(0) and record(-1) are ERR_OUT_OF_RANGE on the native histogram.
    expect(() => {
      durations.record(0);
      durations.record(-1);
      durations.record(0.4);
    }).not.toThrow();
    expect(durations.snapshot().min).toBe(1);
    expect(durations.count).toBe(3);
  });

  it('rounds a fractional observation rather than rejecting it', () => {
    const durations = new Durations();
    durations.record(1500.7);
    expect(durations.snapshot().max).toBe(1501);
  });

  it('reports percentiles as numbers, so a snapshot serialises', () => {
    const durations = new Durations();
    for (let i = 1; i <= 10_000; i += 1) durations.record(i);

    const snapshot = durations.snapshot();
    expect(snapshot.count).toBe(10_000);
    // The native `percentiles` is a Map of bigint that JSON.stringify silently
    // turns into `{}`; `percentile(n)` returns a number and is what is read.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    for (const value of Object.values(snapshot)) {
      expect(typeof value).toBe('number');
    }
  });

  it('is accurate to within a tenth of a percent over a uniform range', () => {
    const durations = new Durations();
    for (let i = 1; i <= 10_000; i += 1) durations.record(i);

    const { p50, p90, p99 } = durations.snapshot();
    expect(Math.abs(Number(p50) - 5000) / 5000).toBeLessThan(0.001);
    expect(Math.abs(Number(p90) - 9000) / 9000).toBeLessThan(0.001);
    expect(Math.abs(Number(p99) - 9900) / 9900).toBeLessThan(0.001);
  });

  it('returns to the empty shape after a reset', () => {
    const durations = new Durations();
    durations.record(500);
    expect(durations.snapshot().count).toBe(1);
    durations.reset();
    expect(durations.snapshot()).toEqual({ count: 0 });
  });
});
