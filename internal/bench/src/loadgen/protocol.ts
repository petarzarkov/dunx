import type { LoadRequest } from '../types.js';

/**
 * Latencies are bucketed into 1µs slots up to 100ms rather than kept as an array:
 * a five-second run at a million rps would otherwise ship five million doubles
 * back over postMessage. Anything slower than the last bucket lands in `overflow`
 * and only moves `maxMicros`.
 */
export const BUCKET_COUNT = 100_000;

export interface WorkerJob {
  readonly request: LoadRequest;
  readonly connections: number;
  readonly durationMs: number;
  readonly startAtEpochMs: number;
}

export interface WorkerReport {
  readonly requests: number;
  readonly non2xx: number;
  readonly errors: number;
  readonly totalMicros: number;
  readonly overflow: number;
  readonly maxMicros: number;
  readonly elapsedMs: number;
  readonly histogram: ArrayBuffer;
}

export const percentileFrom = (
  histogram: Uint32Array,
  overflow: number,
  maxMicros: number,
  fraction: number,
): number => {
  const total = histogram.reduce((sum, count) => sum + count, 0) + overflow;
  if (total === 0) return 0;
  const target = Math.ceil(total * fraction);
  let seen = 0;
  for (let bucket = 0; bucket < histogram.length; bucket += 1) {
    seen += histogram[bucket] ?? 0;
    if (seen >= target) return bucket / 1000;
  }
  return maxMicros / 1000;
};
