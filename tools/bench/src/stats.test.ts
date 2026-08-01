import { describe, expect, test } from 'bun:test';
import { BUCKET_COUNT, percentileFrom } from './loadgen/protocol.js';
import { median, spread, stddev } from './stats.js';

describe('median', () => {
  test('returns 0 for no samples rather than NaN', () => {
    expect(median([])).toBe(0);
  });

  test('takes the middle of an odd-length set regardless of input order', () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  test('averages the two middle values of an even-length set', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('stddev', () => {
  test('is 0 when there is nothing to vary', () => {
    expect(stddev([])).toBe(0);
    expect(stddev([7])).toBe(0);
    expect(stddev([7, 7, 7])).toBe(0);
  });

  test('uses the sample denominator, not the population one', () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
  });
});

describe('spread', () => {
  test('reports median, min, max and stddev together', () => {
    expect(spread([10, 20, 30])).toEqual({
      median: 20,
      min: 10,
      max: 30,
      stddev: 10,
    });
  });
});

describe('percentileFrom', () => {
  const histogram = (counts: Readonly<Record<number, number>>): Uint32Array => {
    const buckets = new Uint32Array(BUCKET_COUNT);
    for (const [bucket, count] of Object.entries(counts))
      buckets[Number(bucket)] = count;
    return buckets;
  };

  test('converts a microsecond bucket index to milliseconds', () => {
    expect(percentileFrom(histogram({ 1500: 1 }), 0, 1500, 0.5)).toBe(1.5);
  });

  test('picks the bucket the requested fraction lands in', () => {
    const buckets = histogram({ 100: 99, 5000: 1 });
    expect(percentileFrom(buckets, 0, 5000, 0.5)).toBe(0.1);
    expect(percentileFrom(buckets, 0, 5000, 0.99)).toBe(0.1);
  });

  test('falls back to the recorded maximum when the percentile is past the last bucket', () => {
    // Two samples in a bucket, ninety-eight beyond 100ms: p99 is in the overflow.
    expect(percentileFrom(histogram({ 100: 2 }), 98, 250_000, 0.99)).toBe(250);
  });

  test('returns 0 when nothing was recorded', () => {
    expect(percentileFrom(new Uint32Array(BUCKET_COUNT), 0, 0, 0.99)).toBe(0);
  });
});
